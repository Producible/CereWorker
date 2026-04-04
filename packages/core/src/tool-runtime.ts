import { createHash } from 'node:crypto';
import type { ToolCall, ToolResult } from './types.js';
import type { ToolDefinition } from './orchestrator.js';
import { isAbortError, raceWithAbort, throwIfAborted } from './abort.js';

export type ToolRuntimeEngine = 'legacy' | 'enhanced';
export type ToolLoopDetectorKind =
  | 'generic_repeat'
  | 'known_poll_no_progress'
  | 'global_circuit_breaker'
  | 'ping_pong';

export interface ToolLoopDetectionConfig {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  criticalThreshold: number;
  globalCircuitBreakerThreshold: number;
  detectors: {
    genericRepeat: boolean;
    knownPollNoProgress: boolean;
    pingPong: boolean;
  };
}

export interface ToolRuntimeConfig {
  engine: ToolRuntimeEngine;
  maxResultChars: number;
  loopDetection: ToolLoopDetectionConfig;
}

export interface ToolExecutionContext {
  callId: string;
  toolName: string;
  conversationId?: string;
  sessionKey?: string;
  scopeKey?: string;
  turnId?: string;
  attempt?: number;
  runtimeEngine: ToolRuntimeEngine;
  abortSignal?: AbortSignal;
}

export interface ToolExecutionValue {
  output?: string;
  isError?: boolean;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  truncated?: boolean;
  synthetic?: boolean;
  warnings?: string[];
  content?: unknown[];
  status?: string;
}

export interface ToolRuntimeExecution {
  toolName: string;
  result: ToolResult;
}

interface ToolHistoryEntry {
  signature: string;
  toolName: string;
  argsHash: string;
  resultHash?: string;
}

interface LoopDetectionOutcome {
  level: 'warning' | 'critical';
  detector: ToolLoopDetectorKind;
  count: number;
  message: string;
}

const KNOWN_POLL_TOOLS = new Set(['query_agents', 'browserWait']);

const DEFAULT_LOOP_DETECTION: ToolLoopDetectionConfig = {
  enabled: false,
  historySize: 30,
  warningThreshold: 10,
  criticalThreshold: 20,
  globalCircuitBreakerThreshold: 30,
  detectors: {
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
  },
};

const DEFAULT_TOOL_RUNTIME_CONFIG: ToolRuntimeConfig = {
  engine: 'enhanced',
  maxResultChars: 20000,
  loopDetection: DEFAULT_LOOP_DETECTION,
};

export class ToolRuntime {
  private config: ToolRuntimeConfig;
  private historyByScope = new Map<string, ToolHistoryEntry[]>();

  constructor(config?: Partial<ToolRuntimeConfig>) {
    this.config = {
      ...DEFAULT_TOOL_RUNTIME_CONFIG,
      ...config,
      loopDetection: {
        ...DEFAULT_LOOP_DETECTION,
        ...config?.loopDetection,
        detectors: {
          ...DEFAULT_LOOP_DETECTION.detectors,
          ...config?.loopDetection?.detectors,
        },
      },
    };
  }

  getConfig(): ToolRuntimeConfig {
    return this.config;
  }

  async execute(params: {
    toolCall: ToolCall;
    tools: Map<string, ToolDefinition> | Record<string, ToolDefinition>;
    conversationId?: string;
    sessionKey?: string;
    scopeKey?: string;
    turnId?: string;
    attempt?: number;
    abortSignal?: AbortSignal;
  }): Promise<ToolRuntimeExecution> {
    const normalizedToolName = normalizeToolName(params.toolCall.name);
    const tool = resolveTool(params.tools, normalizedToolName);
    const executionScope = params.scopeKey ?? params.conversationId ?? params.sessionKey;
    const args = isPlainObject(params.toolCall.args) ? params.toolCall.args : {};
    const context: ToolExecutionContext = {
      callId: params.toolCall.id,
      toolName: normalizedToolName,
      conversationId: params.conversationId,
      sessionKey: params.sessionKey,
      scopeKey: executionScope,
      turnId: params.turnId,
      attempt: params.attempt,
      runtimeEngine: this.config.engine,
      abortSignal: params.abortSignal,
    };

    if (!tool) {
      return {
        toolName: normalizedToolName,
        result: {
          callId: params.toolCall.id,
          output: `Unknown tool: ${normalizedToolName || params.toolCall.name}`,
          isError: true,
          metadata: {
            requestedToolName: params.toolCall.name,
          },
        },
      };
    }

    const warnings: string[] = [];
    if (this.config.engine === 'enhanced') {
      const missing = getMissingRequiredParameters(tool.parameters, args);
      if (missing.length > 0) {
        return {
          toolName: normalizedToolName,
          result: {
            callId: params.toolCall.id,
            output: formatMissingParameterError(missing),
            isError: true,
          },
        };
      }

      const loopOutcome = executionScope
        ? detectLoopBeforeCall(
            this.historyByScope.get(executionScope) ?? [],
            normalizedToolName,
            args,
            this.config.loopDetection,
          )
        : undefined;
      if (loopOutcome?.level === 'critical') {
        return {
          toolName: normalizedToolName,
          result: {
            callId: params.toolCall.id,
            output: loopOutcome.message,
            isError: true,
            metadata: {
              loopDetection: {
                detector: loopOutcome.detector,
                count: loopOutcome.count,
                level: loopOutcome.level,
              },
            },
            warnings: [loopOutcome.message],
          },
        };
      }
      if (loopOutcome) {
        warnings.push(loopOutcome.message);
      }
    }

    let rawResult: unknown;
    try {
      throwIfAborted(params.abortSignal, 'Tool execution aborted');

      const execution = Promise.resolve(tool.execute(args, context));
      rawResult = params.abortSignal
        ? await raceWithAbort(execution, params.abortSignal, 'Tool execution aborted')
        : await execution;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      rawResult = {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
        metadata: {
          runtimeError: true,
        },
      } satisfies ToolExecutionValue;
    }

    let result = normalizeToolExecutionResult({
      callId: params.toolCall.id,
      toolName: normalizedToolName,
      rawResult,
      originalToolName: params.toolCall.name,
    });

    if (warnings.length > 0) {
      result = appendWarnings(result, warnings);
    }

    if (this.config.engine === 'enhanced') {
      result = truncateToolResult(result, this.config.maxResultChars);
      if (executionScope) {
        this.recordToolOutcome(executionScope, normalizedToolName, args, result);
      }
    }

    return { toolName: normalizedToolName, result };
  }

  private recordToolOutcome(
    scopeKey: string,
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): void {
    const history = this.historyByScope.get(scopeKey) ?? [];
    const next = history.concat({
      signature: hashToolCall(toolName, args),
      toolName,
      argsHash: digestStable(args),
      resultHash: hashToolOutcome(result),
    });
    const maxSize = Math.max(
      this.config.loopDetection.historySize,
      this.config.loopDetection.globalCircuitBreakerThreshold,
    );
    this.historyByScope.set(scopeKey, next.slice(-maxSize));
  }
}

function resolveTool(
  tools: Map<string, ToolDefinition> | Record<string, ToolDefinition>,
  normalizedToolName: string,
): ToolDefinition | undefined {
  if (tools instanceof Map) {
    return tools.get(normalizedToolName);
  }
  return tools[normalizedToolName];
}

function normalizeToolExecutionResult(params: {
  callId: string;
  toolName: string;
  rawResult: unknown;
  originalToolName: string;
}): ToolResult {
  const { callId, rawResult, originalToolName, toolName } = params;

  if (typeof rawResult === 'string') {
    return {
      callId,
      output: rawResult,
      isError: false,
      metadata: originalToolName !== toolName
        ? { requestedToolName: originalToolName }
        : undefined,
    };
  }

  if (isPlainObject(rawResult)) {
    const output = resolveResultOutput(rawResult);
    const metadata = isPlainObject(rawResult.metadata) ? rawResult.metadata : undefined;
    const details = isPlainObject(rawResult.details) ? rawResult.details : undefined;
    const warnings = Array.isArray(rawResult.warnings)
      ? rawResult.warnings.filter((value): value is string => typeof value === 'string')
      : undefined;

    return {
      callId,
      output,
      isError: rawResult.isError === true || rawResult.status === 'error',
      details,
      metadata: {
        ...(originalToolName !== toolName ? { requestedToolName: originalToolName } : {}),
        ...(metadata ?? {}),
      },
      truncated: rawResult.truncated === true,
      synthetic: rawResult.synthetic === true,
      warnings,
    };
  }

  return {
    callId,
    output: rawResult === undefined || rawResult === null ? '(no output)' : String(rawResult),
    isError: false,
    metadata: originalToolName !== toolName
      ? { requestedToolName: originalToolName }
      : undefined,
  };
}

function resolveResultOutput(result: Record<string, unknown>): string {
  if (typeof result.output === 'string') {
    return result.output;
  }
  if (Array.isArray(result.content)) {
    const textContent = result.content
      .flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (isPlainObject(entry) && typeof entry.text === 'string') return [entry.text];
        return [];
      })
      .join('\n')
      .trim();
    if (textContent) {
      return textContent;
    }
  }
  if (isPlainObject(result.details)) {
    return safeStringify(result.details);
  }
  return safeStringify(result);
}

function appendWarnings(result: ToolResult, warnings: string[]): ToolResult {
  const currentWarnings = result.warnings ?? [];
  const nextWarnings = currentWarnings.concat(warnings);
  const nextOutput = warnings.reduce((output, warning) => {
    const prefix = output.trim().length > 0 ? `${output}\n` : output;
    return `${prefix}[CereWorker runtime warning: ${warning}]`;
  }, result.output);
  return {
    ...result,
    output: nextOutput,
    warnings: nextWarnings,
  };
}

function truncateToolResult(result: ToolResult, maxResultChars: number): ToolResult {
  if (result.output.length <= maxResultChars) {
    return result;
  }
  const suffix = '\n\n[Tool result truncated during persistence and replay.]';
  const truncated = `${result.output.slice(0, Math.max(0, maxResultChars - suffix.length))}${suffix}`;
  return {
    ...result,
    output: truncated,
    truncated: true,
    details: {
      ...(result.details ?? {}),
      originalOutputChars: result.output.length,
    },
  };
}

function formatMissingParameterError(missing: string[]): string {
  if (missing.length === 1) {
    return `Missing required parameter: ${missing[0]}`;
  }
  return `Missing required parameters: ${missing.join(', ')}`;
}

function getMissingRequiredParameters(
  parameters: unknown,
  args: Record<string, unknown>,
): string[] {
  const required = getRequiredParameters(parameters);
  return required.filter((name) => !(name in args));
}

function getRequiredParameters(parameters: unknown): string[] {
  if (!isPlainObject(parameters)) {
    return [];
  }

  if (Array.isArray(parameters.required)) {
    return parameters.required.filter((value): value is string => typeof value === 'string');
  }

  return Object.entries(parameters)
    .filter(([, descriptor]) => isPlainObject(descriptor) && descriptor.required === true)
    .map(([name]) => name);
}

function detectLoopBeforeCall(
  history: ToolHistoryEntry[],
  toolName: string,
  args: Record<string, unknown>,
  config: ToolLoopDetectionConfig,
): LoopDetectionOutcome | undefined {
  if (!config.enabled) {
    return undefined;
  }

  const signature = hashToolCall(toolName, args);
  const argsHash = digestStable(args);

  if (config.detectors.genericRepeat) {
    const repeatCount = getRepeatStreak(history, signature) + 1;
    if (repeatCount >= config.criticalThreshold) {
      return {
        level: 'critical',
        detector: 'generic_repeat',
        count: repeatCount,
        message: `Critical tool loop detected for ${toolName} (${repeatCount} repeated calls). Stop retrying and report the failure.`,
      };
    }
    if (repeatCount >= config.warningThreshold) {
      return {
        level: 'warning',
        detector: 'generic_repeat',
        count: repeatCount,
        message: `Repeated tool calls detected for ${toolName} (${repeatCount} calls). Try a different approach.`,
      };
    }
  }

  if (config.detectors.knownPollNoProgress && KNOWN_POLL_TOOLS.has(toolName)) {
    const noProgressCount = getNoProgressStreak(history, toolName, argsHash);
    if (noProgressCount >= config.criticalThreshold) {
      return {
        level: 'critical',
        detector: 'known_poll_no_progress',
        count: noProgressCount,
        message: `Polling loop detected for ${toolName} with no progress (${noProgressCount} identical outcomes).`,
      };
    }
    if (noProgressCount >= config.warningThreshold) {
      return {
        level: 'warning',
        detector: 'known_poll_no_progress',
        count: noProgressCount,
        message: `Repeated polling for ${toolName} is returning the same result (${noProgressCount} times).`,
      };
    }
  }

  if (config.detectors.pingPong) {
    const pingPongCount = getPingPongStreak(history, signature) + 1;
    if (pingPongCount >= config.criticalThreshold) {
      return {
        level: 'critical',
        detector: 'ping_pong',
        count: pingPongCount,
        message: `Critical ping-pong loop detected involving ${toolName} (${pingPongCount} alternating calls).`,
      };
    }
    if (pingPongCount >= config.warningThreshold) {
      return {
        level: 'warning',
        detector: 'ping_pong',
        count: pingPongCount,
        message: `Alternating tool-call pattern detected around ${toolName} (${pingPongCount} turns).`,
      };
    }
  }

  const recent = history.slice(-(config.globalCircuitBreakerThreshold - 1));
  if (recent.length + 1 >= config.globalCircuitBreakerThreshold) {
    const distinctSignatures = new Set(recent.map((entry) => entry.signature));
    distinctSignatures.add(signature);
    if (distinctSignatures.size <= 2) {
      return {
        level: 'critical',
        detector: 'global_circuit_breaker',
        count: recent.length + 1,
        message: `Global tool loop circuit breaker tripped after ${recent.length + 1} calls with no meaningful variation.`,
      };
    }
  }

  return undefined;
}

function getRepeatStreak(history: ToolHistoryEntry[], signature: string): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.signature !== signature) {
      break;
    }
    count += 1;
  }
  return count;
}

function getNoProgressStreak(
  history: ToolHistoryEntry[],
  toolName: string,
  argsHash: string,
): number {
  let count = 0;
  let expectedResultHash: string | undefined;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry || entry.toolName !== toolName || entry.argsHash !== argsHash || !entry.resultHash) {
      continue;
    }
    if (!expectedResultHash) {
      expectedResultHash = entry.resultHash;
      count = 1;
      continue;
    }
    if (entry.resultHash !== expectedResultHash) {
      break;
    }
    count += 1;
  }

  return count;
}

function getPingPongStreak(history: ToolHistoryEntry[], currentSignature: string): number {
  const last = history.at(-1);
  if (!last || last.signature === currentSignature) {
    return 0;
  }

  const alternatingSignature = last.signature;
  let expected = alternatingSignature;
  let count = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry || entry.signature !== expected) {
      break;
    }
    count += 1;
    expected = expected === alternatingSignature ? currentSignature : alternatingSignature;
  }

  return count;
}

function hashToolCall(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${digestStable(args)}`;
}

function hashToolOutcome(result: ToolResult): string {
  return digestStable({
    output: result.output,
    isError: result.isError,
    details: result.details ?? null,
  });
}

function digestStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeToolName(name: string): string {
  return name.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
