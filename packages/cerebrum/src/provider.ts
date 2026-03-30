import { createHash } from 'node:crypto';
import { streamText, generateText, jsonSchema, tool, stepCountIs, type ModelMessage, type LanguageModel } from 'ai';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import {
  getCerebrumProvider,
  GOOGLE_OPENAI_BASE_URL,
  OPENAI_CODEX_BASE_URL,
  type ProviderRuntimeFamily,
} from '@cereworker/config';
import {
  createLogger,
  raceWithAbort,
  throwIfAborted,
  type Message,
  type StreamFinishMetadata,
  type StreamFinishReason,
  type ToolCall as CWToolCall,
  type ToolDefinition,
} from '@cereworker/core';
import type { CerebrumConfig, ProviderConfig, StreamCallbacks } from './types.js';
import { withRetry, type RetryOptions } from './retry.js';
import { buildCompactionPrompt } from './context.js';
import { TokenStore, refreshAccessToken, OAUTH_PROVIDERS, refreshMiniMaxPortalToken } from './oauth/index.js';
import { getOpenAICodexApiKey, refreshGoogleToken } from './oauth/pi-auth.js';

const OPENAI_CODEX_PROVIDER = 'openai-codex';
const DEFAULT_OPENAI_CODEX_INSTRUCTIONS = 'You are the Cerebrum of CereWorker, a dual-LLM autonomous agent.';
const MAX_REPLAY_TOOL_RESULT_CHARS = 20000;
const ITERATOR_CLOSE_TIMEOUT_MS = 1_000;
const GOOGLE_API_HOST = 'generativelanguage.googleapis.com';
const TOOL_PARAMETER_SCHEMA_KEYS = new Set([
  '$schema',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'oneOf',
  'anyOf',
  'allOf',
  'title',
  'description',
]);
const log = createLogger('provider');

function asFinishReason(value: unknown): StreamFinishReason | undefined {
  switch (value) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
    case 'other':
      return value;
    default:
      return undefined;
  }
}

interface RuntimeProviderDefinition {
  runtimeFamily: ProviderRuntimeFamily;
  defaultBaseUrl?: string;
}

function getRuntimeProviderDefinition(providerName: string): RuntimeProviderDefinition | null {
  const provider = getCerebrumProvider(providerName);
  if (!provider) {
    return null;
  }

  return {
    runtimeFamily: provider.runtimeFamily,
    defaultBaseUrl: provider.defaultBaseUrl,
  };
}

function friendlyApiError(error: unknown, provider: string, model: string): string {
  if (!(error instanceof Error)) return String(error);
  const msg = error.message;

  // Location restriction (Google)
  if (msg.includes('User location is not supported')) {
    return `${provider} model "${model}" is not available in your region. Try a different model (e.g. gemini-2.0-flash) or switch providers with /provider.`;
  }

  // Auth errors
  if (msg.includes('invalid_api_key') || msg.includes('Incorrect API key') || msg.includes('401')) {
    return `Invalid API key for ${provider}. Check your key in ~/.cereworker/config.yaml or set the appropriate environment variable.`;
  }

  // Rate limits
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    return `Rate limit exceeded for ${provider}. Wait a moment and try again, or switch providers with /provider.`;
  }

  // Model not found
  if (msg.includes('model not found') || msg.includes('does not exist') || msg.includes('404')) {
    return `Model "${model}" not found on ${provider}. Check the model name or use /model to switch.`;
  }

  // Context length
  if (msg.includes('context length') || msg.includes('too many tokens') || msg.includes('maximum')) {
    return `Message too long for ${model}. Try shortening your message or start a new conversation.`;
  }

  // Billing/permissions
  if (msg.includes('billing') || msg.includes('payment') || msg.includes('403')) {
    return `Access denied for ${provider}. Check your billing/plan at the provider's dashboard.`;
  }

  // Network
  if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('fetch failed')) {
    return `Cannot reach ${provider}. Check your internet connection.`;
  }

  // Fall back to the original message but strip the class name prefix
  return msg.replace(/^[A-Za-z_]+Error \[AI_[A-Za-z]+\]: /, '');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeGoogleOpenAIBaseUrl(baseUrl?: string): string {
  const raw = trimTrailingSlashes(baseUrl?.trim() || GOOGLE_OPENAI_BASE_URL);
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';

    if (url.hostname.toLowerCase() === GOOGLE_API_HOST) {
      const normalizedPath = trimTrailingSlashes(url.pathname || '');
      if (!normalizedPath) {
        url.pathname = '/v1beta/openai';
      } else if (normalizedPath === '/openai') {
        url.pathname = '/v1beta/openai';
      } else if (normalizedPath === '/v1beta' || normalizedPath === '/v1') {
        url.pathname = `${normalizedPath}/openai`;
      }
    }

    return trimTrailingSlashes(url.toString());
  } catch {
    if (/^https:\/\/generativelanguage\.googleapis\.com\/?$/i.test(raw)) {
      return GOOGLE_OPENAI_BASE_URL;
    }
    if (/^https:\/\/generativelanguage\.googleapis\.com\/(v1beta|v1)\/?$/i.test(raw)) {
      return `${raw}/openai`;
    }
    if (/^https:\/\/generativelanguage\.googleapis\.com\/openai\/?$/i.test(raw)) {
      return GOOGLE_OPENAI_BASE_URL;
    }
    return raw;
  }
}

export class CerebrumProvider {
  private config: CerebrumConfig;
  private retryOptions: RetryOptions;
  private tokenStore = new TokenStore();

  constructor(
    config: CerebrumConfig,
    _builtinToolConfig?: Partial<import('./tools/shell.js').ShellToolConfig>,
    retryOptions?: RetryOptions,
  ) {
    this.config = config;
    this.retryOptions = retryOptions ?? {};
  }

  private async resolveProviderAuth(
    providerName: string,
    providerConfig?: ProviderConfig,
  ): Promise<{ apiKey?: string; oauthTokens?: import('./oauth/types.js').OAuthTokens }> {
    if (providerConfig?.auth !== 'oauth') {
      return { apiKey: providerConfig?.apiKey };
    }

    const tokens = this.tokenStore.load(providerName);
    if (!tokens) {
      throw new Error(
          `No OAuth tokens found for ${providerName}. Run: cereworker auth ${providerName}`,
      );
    }

    if (providerName === OPENAI_CODEX_PROVIDER) {
      const resolved = await getOpenAICodexApiKey(tokens);
      this.tokenStore.save(OPENAI_CODEX_PROVIDER, resolved.tokens);
      return { apiKey: resolved.apiKey, oauthTokens: resolved.tokens };
    }

    if (this.tokenStore.isExpired(tokens)) {
      if (!tokens.refreshToken) {
        throw new Error(
          `OAuth token expired and no refresh token. Run: cereworker auth ${providerName}`,
        );
      }

      let refreshed;
      if (providerName === 'google') {
        refreshed = await refreshGoogleToken(tokens.refreshToken, tokens.projectId ?? '');
      } else if (providerName === 'minimax-portal') {
        refreshed = await refreshMiniMaxPortalToken(
          tokens.refreshToken,
          providerConfig?.baseUrl ?? tokens.baseUrl ?? tokens.resourceUrl,
        );
      } else {
        const oauthConfig = OAUTH_PROVIDERS[providerName];
        if (!oauthConfig) throw new Error(`No OAuth config for ${providerName}`);
        refreshed = await refreshAccessToken(
          oauthConfig,
          tokens.refreshToken,
          tokens.clientId ?? providerConfig.oauth?.clientId,
          providerConfig.oauth?.clientSecret,
        );
      }

      this.tokenStore.save(providerName, refreshed);
      return { apiKey: refreshed.accessToken, oauthTokens: refreshed };
    }

    return { apiKey: tokens.accessToken, oauthTokens: tokens };
  }

  private resolveProviderSelection(provider?: string): {
    requestedProviderName: string;
    providerName: string;
    providerConfig?: ProviderConfig;
  } {
    const requestedProviderName = provider ?? this.config.defaultProvider;
    const requestedProviderConfig = this.config.providers[requestedProviderName];
    const providerName = requestedProviderName === 'openai' && requestedProviderConfig?.auth === 'oauth'
      ? OPENAI_CODEX_PROVIDER
      : requestedProviderName;
    const providerConfig = this.config.providers[providerName] ?? requestedProviderConfig;

    return { requestedProviderName, providerName, providerConfig };
  }

  private getModelRequestOptions(
    provider?: string,
    systemPrompt?: string,
    temperature?: number,
  ): {
    system?: string;
    temperature?: number;
    providerOptions?: {
      openai: {
        instructions: string;
        store: false;
      };
    };
  } {
    const { providerName } = this.resolveProviderSelection(provider);
    const normalizedSystemPrompt = systemPrompt?.trim();

    if (providerName !== OPENAI_CODEX_PROVIDER) {
      return {
        ...(normalizedSystemPrompt ? { system: normalizedSystemPrompt } : {}),
        ...(typeof temperature === 'number' ? { temperature } : {}),
      };
    }

    return {
      providerOptions: {
        openai: {
          instructions: normalizedSystemPrompt ?? DEFAULT_OPENAI_CODEX_INSTRUCTIONS,
          store: false,
        },
      },
    };
  }

  private async getModel(provider?: string, model?: string): Promise<LanguageModel> {
    const { providerName, providerConfig } = this.resolveProviderSelection(provider);
    const providerDefinition = getRuntimeProviderDefinition(providerName);
    if (!providerDefinition) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    const modelName = model ?? this.config.defaultModel;
    const auth = await this.resolveProviderAuth(providerName, providerConfig);
    const apiKey = auth.apiKey;

    const resolvedBaseUrl =
      providerConfig?.baseUrl
      ?? auth.oauthTokens?.resourceUrl
      ?? auth.oauthTokens?.baseUrl
      ?? providerDefinition.defaultBaseUrl;

    switch (providerDefinition.runtimeFamily) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey,
          ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
        });
        return anthropic(modelName);
      }
      case 'anthropic-auth-token': {
        const anthropic = createAnthropic({
          authToken: apiKey,
          ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
        });
        return anthropic(modelName);
      }
      case 'openai-responses': {
        const openai = createOpenAI({
          apiKey,
          ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
        });
        return openai(modelName);
      }
      case 'openai-chat': {
        const openai = createOpenAI({
          apiKey,
          ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
          ...(providerName === 'xai' ? { fetch: createXaiFetchWrapper() } : {}),
        });
        return openai.chat(modelName);
      }
      case 'openai-codex': {
        const accountId = auth.oauthTokens?.accountId;
        if (!accountId) {
          throw new Error(
            `OpenAI Codex OAuth token is missing account metadata. Run: cereworker auth ${OPENAI_CODEX_PROVIDER}`,
          );
        }

        const openaiCodex = createOpenAI({
          apiKey,
          baseURL: resolvedBaseUrl ?? OPENAI_CODEX_BASE_URL,
          headers: {
            'chatgpt-account-id': accountId,
            'OpenAI-Beta': 'responses=experimental',
            originator: 'cereworker',
            'User-Agent': 'cereworker',
          },
        });
        return openaiCodex.responses(modelName);
      }
      case 'google': {
        const google = createOpenAI({
          apiKey,
          baseURL: normalizeGoogleOpenAIBaseUrl(resolvedBaseUrl),
        });
        return google.chat(modelName);
      }
      case 'local': {
        const local = createOpenAI({
          apiKey: apiKey ?? 'not-needed',
          baseURL: providerConfig?.baseUrl ?? 'http://localhost:11434/v1',
        });
        return local(providerConfig?.model ?? modelName);
      }
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }

  /**
   * Convert CereWorker messages to AI SDK v6 ModelMessage format.
   *
   * DB order:  [user, tool(A), tool(B), cerebrum(toolCalls:[A,B])]
   * SDK order: [user, assistant(toolCalls:[A,B]), tool(A), tool(B)]
   *
   * Tool results are stored during streaming (before the cerebrum message),
   * so we buffer them and emit after the matching cerebrum/assistant message.
   */
  private convertMessages(messages: Message[], providerName: string): ModelMessage[] {
    const sanitizedMessages = sanitizeTranscriptMessages(messages, providerName);

    // Index tool results by callId for fast lookup
    const toolResultsByCallId = new Map<string, Message>();
    for (const m of sanitizedMessages) {
      if (m.role === 'tool' && m.toolResult) {
        toolResultsByCallId.set(m.toolResult.callId, m);
      }
    }

    const result: ModelMessage[] = [];

    for (const m of sanitizedMessages) {
      if (m.role === 'system' || m.role === 'cerebellum' || m.role === 'tool') continue;

      if (m.role === 'user') {
        result.push({ role: 'user', content: m.content } as ModelMessage);
        continue;
      }

      if (m.role === 'cerebrum') {
        if (m.toolCalls?.length) {
          const matchedToolCalls = m.toolCalls.filter((tc) => toolResultsByCallId.has(tc.id));

          if (m.content || matchedToolCalls.length > 0) {
            // Build assistant message with text and any valid tool calls.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const content: any[] = [];
            if (m.content) {
              content.push({ type: 'text', text: m.content });
            }
            for (const tc of matchedToolCalls) {
              content.push({
                type: 'tool-call',
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.args,
              });
            }

            if (content.length > 0) {
              result.push({ role: 'assistant', content } as ModelMessage);
            }
          }

          if (matchedToolCalls.length > 0) {
            // Emit matching tool results immediately after. Orphaned tool
            // results are dropped during transcript sanitization.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const toolResults: any[] = [];
            for (const tc of matchedToolCalls) {
              const tr = toolResultsByCallId.get(tc.id)!;
              toolResults.push({
                type: 'tool-result',
                toolCallId: tr.toolResult!.callId,
                toolName: resolveToolResultName(tr, tc.name),
                output: { type: 'text', value: tr.content },
              });
            }
            result.push({ role: 'tool', content: toolResults } as unknown as ModelMessage);
          }
        } else {
          result.push({ role: 'assistant', content: m.content } as ModelMessage);
        }
        continue;
      }

      // Fallback: treat unknown roles as user
      result.push({ role: 'user', content: m.content } as ModelMessage);
    }

    return result;
  }

  async stream(
    messages: Message[],
    externalTools: Record<string, ToolDefinition>,
    callbacks: StreamCallbacks,
    options?: { provider?: string; model?: string; systemPrompt?: string; maxSteps?: number; abortSignal?: AbortSignal },
  ): Promise<void> {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const { providerName } = this.resolveProviderSelection(options?.provider);

    const model = await this.getModel(options?.provider, options?.model);
    const coreMessages = this.convertMessages(nonSystemMessages, providerName);

    const systemParts: string[] = [];
    if (options?.systemPrompt) systemParts.push(options.systemPrompt);
    for (const sm of systemMessages) {
      systemParts.push(sm.content);
    }
    const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    const modelRequestOptions = this.getModelRequestOptions(
      options?.provider,
      systemPrompt,
      this.config.temperature,
    );

    // Convert orchestrator-registered tools to AI SDK format.
    // Their execute delegates to onToolCall so the orchestrator handles
    // execution, verification, and persistence in one place.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convertedTools: Record<string, any> = {};

    for (const [rawName, def] of Object.entries(externalTools)) {
      const name = normalizeToolName(rawName) || rawName;
      const schema = toToolInputSchema(def.parameters, providerName);

      convertedTools[name] = tool({
        description: def.description,
        inputSchema: schema,
        execute: async (args, { toolCallId }) => {
          const toolResult = callbacks.onToolCall({
            id: toolCallId,
            name,
            args: normalizeToolArgumentsForProvider(
              providerName,
              (args as Record<string, unknown>) ?? {},
            ),
          });
          const result = options?.abortSignal
            ? await raceWithAbort(toolResult, options.abortSignal, 'Stream aborted')
            : await toolResult;
          return result.output;
        },
      });
    }

    await withRetry(async () => {
      try {
        const result = streamText({
          model,
          messages: coreMessages,
          tools: convertedTools,
          stopWhen: stepCountIs(options?.maxSteps ?? 10),
          ...modelRequestOptions,
          ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
        });

        let fullContent = '';
        const collectedToolCalls: CWToolCall[] = [];
        const stepFinishReasons: StreamFinishReason[] = [];
        let finishReason: StreamFinishReason | undefined;
        let rawFinishReason: string | undefined;
        let chunkCount = 0;
        let stepCount = 0;

        // Wrap the stream iteration with abort awareness — the AI SDK may not
        // break the async iterator when abortSignal fires during multi-step tool use
        const abortSignal = options?.abortSignal;
        const iterator = result.fullStream[Symbol.asyncIterator]();

        try {
        while (true) {
          throwIfAborted(abortSignal, 'Stream aborted');

          const nextResult = abortSignal
            ? await raceWithAbort(iterator.next(), abortSignal, 'Stream aborted')
            : await iterator.next();

          if (nextResult.done) break;
          chunkCount++;
          const part = nextResult.value as {
            type: string;
            text?: string;
            toolCallId?: string;
            toolName?: string;
            input?: unknown;
            error?: unknown;
            finishReason?: unknown;
            rawFinishReason?: unknown;
          };

          switch (part.type) {
            case 'text-delta':
              fullContent += part.text ?? '';
              callbacks.onChunk(part.text ?? '');
              break;
            case 'tool-call':
              collectedToolCalls.push({
                id: part.toolCallId!,
                name: normalizeToolName(part.toolName!) || part.toolName!,
                args: normalizeToolArgumentsForProvider(
                  providerName,
                  (part.input as Record<string, unknown>) ?? {},
                ),
              });
              break;
            case 'finish-step': {
              stepCount++;
              const stepFinishReason = asFinishReason(part.finishReason);
              if (stepFinishReason) {
                stepFinishReasons.push(stepFinishReason);
                finishReason = stepFinishReason;
              }
              if (typeof part.rawFinishReason === 'string') {
                rawFinishReason = part.rawFinishReason;
              }
              break;
            }
            case 'finish': {
              const streamFinishReason = asFinishReason(part.finishReason);
              if (streamFinishReason) {
                finishReason = streamFinishReason;
              }
              if (typeof part.rawFinishReason === 'string') {
                rawFinishReason = part.rawFinishReason;
              }
              break;
            }
            case 'error':
              callbacks.onError(
                part.error instanceof Error ? part.error : new Error(String(part.error)),
              );
              break;
          }
        }
        } catch (abortErr) {
          // Tear down the underlying stream so tool execution doesn't continue in background
          log.debug('provider_abort_observed', { hasAbortSignal: !!abortSignal });
          await closeStreamIterator(iterator, ITERATOR_CLOSE_TIMEOUT_MS);
          throw abortErr;
        }

        const finishMeta: StreamFinishMetadata = {
          finishReason,
          rawFinishReason,
          stepFinishReasons,
          chunkCount,
          textChars: fullContent.length,
          toolCallCount: collectedToolCalls.length,
          hadToolActivity: collectedToolCalls.length > 0,
          stepCount,
        };
        callbacks.onFinish(fullContent, collectedToolCalls.length > 0 ? collectedToolCalls : undefined, finishMeta);
      } catch (error) {
        const provider = options?.provider ?? this.config.defaultProvider;
        const modelName = options?.model ?? this.config.defaultModel;
        const friendly = friendlyApiError(error, provider, modelName);
        callbacks.onError(new Error(friendly));
        throw error;
      }
    }, this.retryOptions);
  }

  getDefaultProvider(): string {
    return this.config.defaultProvider;
  }

  getDefaultModel(): string {
    return this.config.defaultModel;
  }

  setProvider(provider: string): void {
    this.config.defaultProvider = provider;
  }

  setModel(model: string): void {
    this.config.defaultModel = model;
  }

  /**
   * Summarize a list of messages into a concise summary via a single LLM call.
   * Used for context window compaction.
   */
  async summarize(messages: Message[]): Promise<string> {
    const model = await this.getModel();
    const prompt = buildCompactionPrompt(messages);
    const modelRequestOptions = this.getModelRequestOptions(undefined, undefined, 0.3);

    const result = await withRetry(async () => {
      const { text } = await generateText({
        model,
        prompt,
        ...modelRequestOptions,
      });
      return text;
    }, this.retryOptions);

    return result;
  }

  /** Single-shot text generation from a raw prompt. */
  async generate(prompt: string): Promise<string> {
    const model = await this.getModel();
    const modelRequestOptions = this.getModelRequestOptions(undefined, undefined, 0.3);
    const result = await withRetry(async () => {
      const { text } = await generateText({
        model,
        prompt,
        ...modelRequestOptions,
      });
      return text;
    }, this.retryOptions);
    return result;
  }
}

/** Duck-type check: does this look like a Zod schema? */
function isZodSchema(obj: unknown): boolean {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    '_def' in (obj as Record<string, unknown>) &&
    typeof (obj as Record<string, unknown>).parse === 'function'
  );
}

function toToolInputSchema(parameters: unknown, providerName: string) {
  if (isZodSchema(parameters)) {
    return parameters as unknown as z.ZodTypeAny;
  }

  return jsonSchema(normalizeToolParameterSchema(parameters, providerName) as never);
}

function normalizeToolParameterSchema(
  parameters: unknown,
  providerName: string,
): Record<string, unknown> {
  const baseSchema = !parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    ? {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }
    : looksLikeJsonSchema(parameters as Record<string, unknown>)
      ? normalizeJsonSchemaObject(parameters as Record<string, unknown>)
      : legacyParameterMapToJsonSchema(parameters as Record<string, unknown>);

  const flattened = flattenTopLevelObjectUnion(baseSchema);
  const objectSchema = ensureTopLevelObjectSchema(flattened);
  return cleanSchemaForProvider(objectSchema, providerName);
}

function looksLikeJsonSchema(schema: Record<string, unknown>): boolean {
  return Object.keys(schema).some((key) => TOOL_PARAMETER_SCHEMA_KEYS.has(key));
}

function normalizeJsonSchemaObject(schema: Record<string, unknown>): Record<string, unknown> {
  return ensureTopLevelObjectSchema(schema);
}

function ensureTopLevelObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...schema };
  const hasObjectFields =
    (typeof normalized.properties === 'object' && normalized.properties !== null) ||
    Array.isArray(normalized.required);

  if (
    normalized.type === 'object' ||
    (!('type' in normalized) && hasObjectFields) ||
    (Object.keys(normalized).length === 0)
  ) {
    normalized.type = 'object';
    if (
      !('properties' in normalized) ||
      typeof normalized.properties !== 'object' ||
      normalized.properties === null ||
      Array.isArray(normalized.properties)
    ) {
      normalized.properties = {};
    }
  }

  if (!('additionalProperties' in normalized)) {
    normalized.additionalProperties = false;
  }

  return normalized;
}

function flattenTopLevelObjectUnion(schema: Record<string, unknown>): Record<string, unknown> {
  const variantKey = Array.isArray(schema.anyOf)
    ? 'anyOf'
    : Array.isArray(schema.oneOf)
      ? 'oneOf'
      : null;
  if (!variantKey) {
    return schema;
  }

  const variants = schema[variantKey] as unknown[];
  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of variants) {
    if (!isPlainObject(entry) || !isPlainObject(entry.properties)) {
      continue;
    }
    objectVariants += 1;

    for (const [key, value] of Object.entries(entry.properties)) {
      mergedProperties[key] = mergePropertySchemas(mergedProperties[key], value);
    }

    const required = Array.isArray(entry.required)
      ? entry.required.filter((value): value is string => typeof value === 'string')
      : [];
    for (const name of required) {
      requiredCounts.set(name, (requiredCounts.get(name) ?? 0) + 1);
    }
  }

  const baseRequired = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : objectVariants > 0
        ? Array.from(requiredCounts.entries())
            .filter(([, count]) => count === objectVariants)
            .map(([name]) => name)
        : undefined;

  return {
    type: 'object',
    ...(typeof schema.title === 'string' ? { title: schema.title } : {}),
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    properties: Object.keys(mergedProperties).length > 0
      ? mergedProperties
      : (isPlainObject(schema.properties) ? schema.properties : {}),
    ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
    additionalProperties: 'additionalProperties' in schema ? schema.additionalProperties : false,
  };
}

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!isPlainObject(schema)) {
    return undefined;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum;
  }
  if ('const' in schema) {
    return [schema.const];
  }
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (!variants) {
    return undefined;
  }

  const values = variants.flatMap((variant) => extractEnumValues(variant) ?? []);
  return values.length > 0 ? values : undefined;
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingEnum = extractEnumValues(existing);
  const incomingEnum = extractEnumValues(incoming);
  if (!existingEnum && !incomingEnum) {
    return existing;
  }

  const merged: Record<string, unknown> = {};
  for (const source of [existing, incoming]) {
    if (!isPlainObject(source)) continue;
    for (const key of ['title', 'description', 'default'] as const) {
      if (!(key in merged) && key in source) {
        merged[key] = source[key];
      }
    }
  }

  const values = Array.from(new Set([...(existingEnum ?? []), ...(incomingEnum ?? [])]));
  const valueTypes = Array.from(new Set(values.map((value) => typeof value)));
  if (valueTypes.length === 1) {
    merged.type = valueTypes[0];
  }
  merged.enum = values;
  return merged;
}

function cleanSchemaForProvider(
  schema: Record<string, unknown>,
  providerName: string,
): Record<string, unknown> {
  if (providerName === 'google') {
    return cleanSchemaForGemini(schema) as Record<string, unknown>;
  }
  return schema;
}

const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'patternProperties',
  'additionalProperties',
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'examples',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'multipleOf',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

function cleanSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((value) => cleanSchemaForGemini(value));
  }
  if (!isPlainObject(schema)) {
    return schema;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }

    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      const variants = value
        .map((variant) => cleanSchemaForGemini(variant))
        .filter((variant) => !isNullSchema(variant));
      const flattenedLiteral = tryFlattenLiteralUnion(variants);

      if (flattenedLiteral) {
        Object.assign(result, flattenedLiteral);
        continue;
      }

      if (variants.length === 1) {
        const lone = variants[0];
        if (isPlainObject(lone)) {
          Object.assign(result, lone);
        }
        continue;
      }

      result[key] = variants;
      continue;
    }

    if (key === 'type' && value === 'integer') {
      result.type = 'number';
      continue;
    }

    result[key] = cleanSchemaForGemini(value);
  }

  return result;
}

function tryFlattenLiteralUnion(variants: unknown[]): { type: string; enum: unknown[] } | null {
  if (variants.length === 0) {
    return null;
  }

  const values: unknown[] = [];
  let commonType: string | null = null;

  for (const variant of variants) {
    if (!isPlainObject(variant)) {
      return null;
    }

    let literalValue: unknown;
    if ('const' in variant) {
      literalValue = variant.const;
    } else if (Array.isArray(variant.enum) && variant.enum.length === 1) {
      literalValue = variant.enum[0];
    } else {
      return null;
    }

    const variantType = typeof variant.type === 'string' ? variant.type : null;
    if (!variantType) {
      return null;
    }

    if (commonType === null) {
      commonType = variantType;
    } else if (commonType !== variantType) {
      return null;
    }

    values.push(literalValue);
  }

  return commonType ? { type: commonType, enum: values } : null;
}

function isNullSchema(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  if ('const' in value && value.const === null) {
    return true;
  }
  if (Array.isArray(value.enum) && value.enum.length === 1 && value.enum[0] === null) {
    return true;
  }
  return value.type === 'null';
}

function sanitizeTranscriptMessages(messages: Message[], providerName: string): Message[] {
  const resolver = createToolCallIdResolver(getToolCallIdMode(providerName));
  const sanitized: Message[] = [];

  for (const message of messages) {
    if (message.role === 'cerebrum' && message.toolCalls?.length) {
      const toolCalls = message.toolCalls.flatMap((toolCall) => {
        const toolName = normalizeToolName(toolCall.name);
        if (!toolName) {
          return [];
        }
        return [{
          ...toolCall,
          id: resolver.resolveAssistantId(toolCall.id),
          name: toolName,
          args: isPlainObject(toolCall.args) ? toolCall.args : {},
        }];
      });

      if (toolCalls.length === 0 && message.content.trim().length === 0) {
        continue;
      }

      sanitized.push({
        ...message,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }

    if (message.role === 'tool') {
      if (!message.toolResult) {
        continue;
      }

      const callId = resolver.resolveToolResultId(message.toolResult.callId);
      if (!callId) {
        continue;
      }

      const toolName = resolveToolResultName(message);
      const truncated = truncateReplayToolResult(message.toolResult.output);
      const details = truncated.truncated
        ? {
            ...(message.toolResult.details ?? {}),
            originalOutputChars: message.toolResult.output.length,
          }
        : message.toolResult.details;

      sanitized.push({
        ...message,
        content: truncated.output,
        toolResult: {
          ...message.toolResult,
          callId,
          output: truncated.output,
          truncated: message.toolResult.truncated === true || truncated.truncated,
          details,
          metadata: {
            ...(message.toolResult.metadata ?? {}),
            ...(toolName ? { toolName } : {}),
          },
        },
        metadata: {
          ...(message.metadata ?? {}),
          ...(toolName ? { toolName } : {}),
        },
      });
      continue;
    }

    sanitized.push(message);
  }

  return sanitized;
}

function truncateReplayToolResult(output: string): { output: string; truncated: boolean } {
  if (output.length <= MAX_REPLAY_TOOL_RESULT_CHARS) {
    return { output, truncated: false };
  }

  const suffix = '\n\n[Tool result truncated during transcript replay.]';
  return {
    output: `${output.slice(0, Math.max(0, MAX_REPLAY_TOOL_RESULT_CHARS - suffix.length))}${suffix}`,
    truncated: true,
  };
}

function createXaiFetchWrapper(): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== 'string') {
      return fetch(input, init);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return fetch(input, init);
    }

    if (Array.isArray(payload.tools)) {
      payload.tools = payload.tools.map((tool) => stripUnsupportedStrictFlag(tool));
    }

    return fetch(input, {
      ...init,
      body: JSON.stringify(payload),
    });
  };
}

function stripUnsupportedStrictFlag(toolDefinition: unknown): unknown {
  if (!isPlainObject(toolDefinition) || !isPlainObject(toolDefinition.function)) {
    return toolDefinition;
  }

  if (typeof toolDefinition.function.strict !== 'boolean') {
    return toolDefinition;
  }

  const nextFunction = { ...toolDefinition.function };
  delete nextFunction.strict;
  return {
    ...toolDefinition,
    function: nextFunction,
  };
}

function normalizeToolArgumentsForProvider(
  providerName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (providerName !== 'xai') {
    return args;
  }

  return decodeHtmlEntitiesInValue(structuredClone(args)) as Record<string, unknown>;
}

function decodeHtmlEntitiesInValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('&quot;', '"')
      .replaceAll('&#34;', '"')
      .replaceAll('&apos;', '\'')
      .replaceAll('&#39;', '\'')
      .replaceAll('&lt;', '<')
      .replaceAll('&#60;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&#62;', '>')
      .replaceAll('&amp;', '&')
      .replaceAll('&#38;', '&');
  }

  if (Array.isArray(value)) {
    return value.map((entry) => decodeHtmlEntitiesInValue(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeHtmlEntitiesInValue(entry)]),
  );
}

type ToolCallIdMode = 'identity' | 'strict' | 'strict9';

function getToolCallIdMode(providerName: string): ToolCallIdMode {
  if (providerName === 'anthropic' || providerName === 'minimax' || providerName === 'minimax-portal') {
    return 'identity';
  }

  if (providerName === 'mistral') {
    return 'strict9';
  }

  return 'strict';
}

function createToolCallIdResolver(mode: ToolCallIdMode): {
  resolveAssistantId: (id: string) => string;
  resolveToolResultId: (id: string) => string | null;
} {
  const used = new Set<string>();
  const assistantOccurrences = new Map<string, number>();
  const pendingByRawId = new Map<string, string[]>();

  const resolveAssistantId = (id: string): string => {
    const occurrence = (assistantOccurrences.get(id) ?? 0) + 1;
    assistantOccurrences.set(id, occurrence);
    const seed = occurrence === 1 ? id : `${id}:${occurrence}`;
    const nextId = makeUniqueToolId(seed, used, mode);
    const pending = pendingByRawId.get(id);
    if (pending) {
      pending.push(nextId);
    } else {
      pendingByRawId.set(id, [nextId]);
    }
    return nextId;
  };

  const resolveToolResultId = (id: string): string | null => {
    const pending = pendingByRawId.get(id);
    if (!pending || pending.length === 0) {
      return null;
    }

    const nextId = pending.shift() ?? null;
    if (pending.length === 0) {
      pendingByRawId.delete(id);
    }
    return nextId;
  };

  return { resolveAssistantId, resolveToolResultId };
}

function makeUniqueToolId(id: string, used: Set<string>, mode: ToolCallIdMode): string {
  if (mode === 'strict9') {
    const candidate = sanitizeToolCallId(id, mode);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }

    for (let index = 0; index < 1000; index += 1) {
      const hashed = shortHash(`${id}:${index}`, 9);
      if (!used.has(hashed)) {
        used.add(hashed);
        return hashed;
      }
    }

    const fallback = shortHash(`${id}:${Date.now()}`, 9);
    used.add(fallback);
    return fallback;
  }

  const maxLength = 40;
  const base = sanitizeToolCallId(id, mode).slice(0, maxLength) || 'toolcall';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const suffix = mode === 'strict' ? `x${index}` : `_${index}`;
    const candidate = `${base.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  const fallback = `${base.slice(0, maxLength - 4)}tail`;
  used.add(fallback);
  return fallback;
}

function sanitizeToolCallId(id: string, mode: ToolCallIdMode): string {
  if (!id || typeof id !== 'string') {
    return mode === 'strict9' ? 'defaultid' : 'toolcall';
  }
  if (mode === 'identity') {
    return id;
  }

  if (mode === 'strict9') {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, '');
    if (alphanumericOnly.length >= 9) {
      return alphanumericOnly.slice(0, 9);
    }
    if (alphanumericOnly.length > 0) {
      return shortHash(alphanumericOnly, 9);
    }
    return shortHash('sanitized', 9);
  }

  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, '');
  return alphanumericOnly || 'toolcall';
}

function shortHash(text: string, length = 8): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

function resolveToolResultName(message: Message, fallbackName?: string): string {
  const candidates = [
    message.metadata?.toolName,
    message.toolResult?.metadata?.toolName,
    fallbackName,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeToolName(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return 'unknown';
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function legacyParameterMapToJsonSchema(parameterMap: Record<string, unknown>): Record<string, unknown> {
  const properties = Object.fromEntries(
    Object.entries(parameterMap).map(([name, descriptor]) => [
      name,
      legacyParameterDescriptorToJsonSchema(descriptor),
    ]),
  );

  const required = Object.entries(parameterMap)
    .filter(([, descriptor]) => isLegacyParameterDescriptor(descriptor) && descriptor.required === true)
    .map(([name]) => name);

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function legacyParameterDescriptorToJsonSchema(descriptor: unknown): Record<string, unknown> {
  if (!isLegacyParameterDescriptor(descriptor)) {
    return { type: 'string' };
  }

  const schema: Record<string, unknown> = {};
  const type = typeof descriptor.type === 'string' ? descriptor.type : undefined;

  if (typeof descriptor.description === 'string') {
    schema.description = descriptor.description;
  }
  if ('default' in descriptor && descriptor.default !== undefined) {
    schema.default = descriptor.default;
  }
  if (Array.isArray(descriptor.enum) && descriptor.enum.length > 0) {
    schema.enum = descriptor.enum;
  }

  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      schema.type = type;
      break;
    case 'array':
      schema.type = 'array';
      schema.items = isLegacyParameterDescriptor(descriptor.items)
        ? legacyParameterDescriptorToJsonSchema(descriptor.items)
        : {};
      break;
    case 'object':
      schema.type = 'object';
      if (descriptor.properties && typeof descriptor.properties === 'object' && !Array.isArray(descriptor.properties)) {
        schema.properties = Object.fromEntries(
          Object.entries(descriptor.properties).map(([name, value]) => [
            name,
            legacyParameterDescriptorToJsonSchema(value),
          ]),
        );
      } else {
        schema.properties = {};
      }
      schema.additionalProperties =
        'additionalProperties' in descriptor ? descriptor.additionalProperties : true;
      break;
    default:
      schema.type = 'string';
      break;
  }

  return schema;
}

function isLegacyParameterDescriptor(value: unknown): value is Record<string, unknown> & {
  type?: unknown;
  description?: unknown;
  required?: unknown;
  default?: unknown;
  enum?: unknown;
  items?: unknown;
  properties?: unknown;
  additionalProperties?: unknown;
} {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function closeStreamIterator(
  iterator: AsyncIterator<unknown>,
  timeoutMs: number,
): Promise<void> {
  if (typeof iterator.return !== 'function') {
    return;
  }

  const timedOut = Symbol('iterator-close-timeout');
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const result = await Promise.race([
      Promise.resolve(iterator.return(undefined)),
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (result === timedOut) {
      log.warn('provider_abort_teardown_timeout', { timeoutMs });
    }
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }
    log.warn('provider_abort_teardown_failed', {
      timeoutMs,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
