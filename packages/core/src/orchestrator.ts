import { nanoid } from 'nanoid';
import { TypedEventEmitter, type WatchdogStage } from './events.js';
import { ConversationStore, type TurnJournalRetentionPolicy } from './conversation.js';
import { SubAgentManager } from './sub-agent-manager.js';
import { createSubAgentTools } from './sub-agent-tools.js';
import { createLogger } from './logger.js';
import { buildSystemPrompt } from './system-prompt.js';
import type {
  BrowserStateSnapshot,
  BrowserTabSnapshot,
  Message,
  AgentHealthAction,
  ProgressEntry,
  QuerySession,
  RecoveryAction,
  RecoveryCause,
  SessionMemorySnapshot,
  SessionSource,
  StreamContentKind,
  SessionEvent,
  SessionEventType,
  QuerySessionState,
  TaskCheckpoint,
  TaskCheckpointStatus,
  ToolCall,
  ToolResult,
  TurnBoundarySummary,
  TurnJournalEntry,
  TurnJournalEntryType,
  TurnOutcome,
  TurnRecoveryAssessment,
  TurnRecoveryRequest,
  VerificationResult,
  StreamFinishMetadata,
  StreamPhase,
} from './types.js';
import { estimateMessageTokens, shouldCompact, buildCompactionMessages } from './context.js';
import type { InstanceStore, FineTuneRecord } from './instance.js';
import { createAbortError, throwIfAborted } from './abort.js';
import {
  ToolRuntime,
  type ToolExecutionContext,
  type ToolExecutionValue,
  type ToolRuntimeConfig,
} from './tool-runtime.js';

const log = createLogger('orchestrator');
const TASK_COMPLETE_TOOL = 'task_complete';
const TASK_BLOCKED_TOOL = 'task_blocked';
const TASK_CHECKPOINT_TOOL = 'task_checkpoint';
const INTERNAL_TASK_TOOL_NAMES = new Set([
  TASK_COMPLETE_TOOL,
  TASK_BLOCKED_TOOL,
  TASK_CHECKPOINT_TOOL,
]);
const SYSTEM_FALLBACK_COMPLETION_PROMPT =
  '[System fallback] The last turn ended without a final answer. Continue from the last verified state and end by calling task_complete or task_blocked before your final answer.';
const SYSTEM_FALLBACK_STALL_PROMPT =
  '[System fallback] The stalled turn is being retried from the last verified state.';
const DEBUG_TOOL_OUTPUT_MAX_CHARS = 8_000;
const DEBUG_TOOL_STRUCTURED_MAX_CHARS = 16_000;
const READ_ONLY_TOOL_NAMES = new Set([
  'browserGetText',
  'browserGetUrl',
  'browserListTabs',
  'browserWait',
  'browserEval',
  'readFile',
  'listDirectory',
  'searchFiles',
  'glob',
  'memory_read',
  'webSearch',
  'httpFetch',
]);

type CompletionSignal = 'none' | 'complete' | 'blocked';
type RecoverySource = 'cerebellum' | 'fallback';

interface TurnContinuityState {
  progressLedger: ProgressEntry[];
  taskCheckpoints: TaskCheckpoint[];
  browserState: BrowserStateSnapshot;
  boundaries: TurnBoundarySummary[];
}

interface AttemptCompletionState {
  signal: CompletionSignal;
  evidence: string;
  summary?: string;
  blocker?: string;
  successfulExternalToolCount: number;
  externalToolCallCount: number;
  internalToolCallCount: number;
  continuity: TurnContinuityState;
}

interface CompletionGuardFailure {
  message: string;
  signal: CompletionSignal;
}

type RetryCause = 'stall' | 'completion';

interface BrowserResumeMetadata {
  action?: string;
  summary?: string;
  url?: string;
  tabId?: string;
  activeTabId?: string;
  tabs?: BrowserTabSnapshot[];
  targetText?: string;
  targetSelector?: string;
  stateChanging?: boolean;
  stateDelta?: Record<string, unknown>;
}

export interface CerebrumAdapter {
  stream(
    messages: Message[],
    tools: Record<string, ToolDefinition>,
    callbacks: StreamCallbacks,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void>;
  summarize?(messages: Message[]): Promise<string>;
}

export interface ToolDefinition {
  description: string;
  parameters: unknown;
  execute: (
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<string | ToolExecutionValue>;
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onToolCall: (toolCall: ToolCall) => Promise<ToolResult>;
  onFinish: (content: string, toolCalls?: ToolCall[], finishMeta?: StreamFinishMetadata) => void;
  onError: (error: Error) => void;
}

export interface FineTuneStatus {
  status: 'idle' | 'running' | 'completed' | 'failed';
  jobId: string;
  progress: number;
  currentStep: number;
  totalSteps: number;
  currentLoss: number;
  error: string;
  checkpointPath: string;
  startedAt: number;
  completedAt: number;
}

export interface TrainingPair {
  instruction: string;
  response: string;
  source: string;
  createdAt: number;
}

export interface CerebellumAdapter {
  isConnected(): boolean;
  assessTurnRecovery?(request: TurnRecoveryRequest): Promise<TurnRecoveryAssessment | null>;
  verifyToolResult(
    toolName: string,
    toolArgs: Record<string, string>,
    toolOutput: string,
    claimedSuccess: boolean,
  ): Promise<{
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; description: string }>;
    modelVerdict: boolean;
  } | null>;
  reportAgentStates?(
    agents: Array<{
      id: string;
      task: string;
      status: string;
      spawnedAt: number;
      lastActivityAt: number;
      timeoutMs: number;
      messagesCount: number;
      toolCallsCount: number;
      retryCount: number;
    }>,
  ): Promise<AgentHealthAction[]>;
  ingestTrainingData?(pairs: TrainingPair[]): Promise<number>;
  startFineTune?(config?: {
    method?: string;
  }): Promise<{ jobId: string; started: boolean; error: string }>;
  getFineTuneStatus?(): Promise<FineTuneStatus | null>;
}

export interface CompactionConfig {
  enabled: boolean;
  threshold: number;
  keepRecentMessages: number;
  contextWindow: number;
}

export interface StreamState {
  streaming: boolean;
  lastActivityAt: number;
  stallDetected: boolean;
  nudgeCount: number;
  phase: StreamPhase;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolStartedAt?: number;
}

export interface OrchestratorOptions {
  conversationStore?: ConversationStore;
  compaction?: Partial<CompactionConfig>;
  toolRuntime?: Partial<ToolRuntimeConfig>;
  streamStallThreshold?: number;
  maxNudgeRetries?: number;
  turnJournalRetention?: TurnJournalRetentionPolicy;
}

export interface SendMessageOptions {
  source?: SessionSource;
  ingress?: {
    channelId?: string;
    senderId?: string;
    senderName?: string;
    threadId?: string;
    replyToId?: string;
    timestamp?: number;
  };
}

export class Orchestrator extends TypedEventEmitter {
  private conversations: ConversationStore;
  private cerebrum: CerebrumAdapter | null = null;
  private cerebellum: CerebellumAdapter | null = null;
  private subAgentManager: SubAgentManager | null = null;
  private internalTools = new Map<string, ToolDefinition>();
  private tools = new Map<string, ToolDefinition>();
  private activeConversationId: string | null = null;
  private systemContext: string | null = null;
  private verificationEnabled = true;
  private verificationTimeoutMs = 5000;
  private monitorIntervalMs = 30_000;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private autoMode = false;
  private fineTunePoller: ReturnType<typeof setInterval> | null = null;
  private fineTuneDataProvider: (() => Promise<TrainingPair[]>) | null = null;
  private fineTuneMethod = 'auto';
  private fineTuneSchedule = 'auto';
  private fineTuneStatus: FineTuneStatus = {
    status: 'idle',
    jobId: '',
    progress: 0,
    currentStep: 0,
    totalSteps: 0,
    currentLoss: 0,
    error: '',
    checkpointPath: '',
    startedAt: 0,
    completedAt: 0,
  };
  private _fineTuneHistory: Array<{
    jobId: string;
    status: string;
    completedAt: number;
    loss: number;
  }> = [];
  private gatewayMode: 'standalone' | 'gateway' | 'node' = 'standalone';
  private connectedNodes = 0;
  private gatewayUrl: string | undefined;
  private profile: { name: string; role: string; traits: string[] } | undefined;
  private instanceStore: InstanceStore | null = null;
  private proactiveEnabled = false;
  private discoveryMode = false;
  private onDiscoveryComplete:
    | ((result: { name: string; role: string; traits: string[] }) => void)
    | null = null;
  private lastStreamActivityAt = 0;
  private streamWatchdog: ReturnType<typeof setInterval> | null = null;
  private streamNudgeCount = 0;
  private streamDeferredUntil = 0;
  private streamStallThreshold = 30_000;
  private maxNudgeRetries = 2;
  private maxCompletionRetries = 2;
  private turnJournalRetention: TurnJournalRetentionPolicy = {
    maxDays: 30,
    maxFilesPerConversation: 100,
  };
  private streamPhase: StreamPhase = 'idle';
  private activeToolCall: { id: string; name: string; startedAt: number } | null = null;
  private currentStreamTurn:
    | {
        turnId: string;
        attempt: number;
        conversationId: string;
        sessionId: string;
        source: SessionSource;
      }
    | null = null;
  private currentQuerySession: QuerySession | null = null;
  private currentAttemptCompletionState: AttemptCompletionState | null = null;
  private currentPartialContent = '';
  private currentLastContentKind: StreamContentKind = 'empty';
  private currentJournaledContentLength = 0;
  private pendingRecoveryDecision: {
    cause: RecoveryCause;
    source: RecoverySource;
    assessment: TurnRecoveryAssessment;
  } | null = null;
  private streamAbortGraceMs = 1_000;
  private taskConversations = new Map<string, string>();
  private taskRunning = new Set<string>();
  private recurringTasks: Array<{ id: string; goal: string; schedule: string }> = [];
  private toolRuntime: ToolRuntime;
  private compactionConfig: CompactionConfig = {
    enabled: true,
    threshold: 0.8,
    keepRecentMessages: 10,
    contextWindow: 128000,
  };

  constructor(options?: OrchestratorOptions) {
    super();
    this.conversations = options?.conversationStore ?? new ConversationStore();
    this.toolRuntime = new ToolRuntime(options?.toolRuntime);
    this.registerInternalTools();
    if (options?.compaction) {
      this.compactionConfig = { ...this.compactionConfig, ...options.compaction };
    }
    if (options?.streamStallThreshold)
      this.streamStallThreshold = options.streamStallThreshold * 1000;
    if (options?.maxNudgeRetries) {
      this.maxNudgeRetries = options.maxNudgeRetries;
      this.maxCompletionRetries = options.maxNudgeRetries;
    }
    if (options?.turnJournalRetention) {
      this.turnJournalRetention = {
        ...this.turnJournalRetention,
        ...options.turnJournalRetention,
      };
    }
  }

  setCerebrum(cerebrum: CerebrumAdapter): void {
    this.cerebrum = cerebrum;
  }

  setCerebellum(
    cerebellum: CerebellumAdapter,
    options?: { enabled?: boolean; timeoutMs?: number },
  ): void {
    this.cerebellum = cerebellum;
    if (options?.enabled !== undefined) this.verificationEnabled = options.enabled;
    if (options?.timeoutMs !== undefined) this.verificationTimeoutMs = options.timeoutMs;
  }

  /** Set system context (e.g. skills prompt) prepended to every Cerebrum call */
  setSystemContext(context: string): void {
    this.systemContext = context;
    log.info('System context updated', { length: context.length });
  }

  getSystemContext(): string | null {
    return this.systemContext;
  }

  setupSubAgents(options?: {
    maxConcurrent?: number;
    baseDir?: string;
    monitorIntervalMs?: number;
  }): SubAgentManager | null {
    if (!this.cerebrum) return null;

    if (options?.monitorIntervalMs) this.monitorIntervalMs = options.monitorIntervalMs;

    this.subAgentManager = new SubAgentManager({
      cerebrum: this.cerebrum,
      tools: this.tools,
      maxConcurrent: options?.maxConcurrent,
      baseDir: options?.baseDir,
      toolRuntime: this.toolRuntime,
      onProgress: (agentId, note, percent) => {
        this.emit({ type: 'agent:progress', agentId, note, percent });
      },
    });

    // Register sub-agent tools with the orchestrator
    const agentTools = createSubAgentTools(this.subAgentManager);
    for (const [name, tool] of Object.entries(agentTools)) {
      this.tools.set(name, tool);
    }

    return this.subAgentManager;
  }

  getSubAgentManager(): SubAgentManager | null {
    return this.subAgentManager;
  }

  getConversationStore(): ConversationStore {
    return this.conversations;
  }

  private registerInternalTools(): void {
    this.internalTools.set(TASK_COMPLETE_TOOL, {
      description:
        'Record that a tool-driven task is complete. Call this once right before your final answer with a concise summary and concrete evidence.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Short summary of what was completed' },
          evidence: { type: 'string', description: 'Concrete evidence proving completion' },
        },
        required: ['summary', 'evidence'],
        additionalProperties: false,
      },
      execute: async (args) => this.recordCompletionSignal('complete', args),
    });

    this.internalTools.set(TASK_BLOCKED_TOOL, {
      description:
        'Record that you are blocked and cannot finish the task. Call this once right before your final answer with the blocker and evidence.',
      parameters: {
        type: 'object',
        properties: {
          blocker: { type: 'string', description: 'Specific blocker preventing completion' },
          evidence: { type: 'string', description: 'Concrete evidence showing the blocker' },
        },
        required: ['blocker', 'evidence'],
        additionalProperties: false,
      },
      execute: async (args) => this.recordCompletionSignal('blocked', args),
    });

    this.internalTools.set(TASK_CHECKPOINT_TOOL, {
      description:
        'Record a completed or in-progress milestone during a multi-step task. Use this after each major verified step so retries can resume from the right place.',
      parameters: {
        type: 'object',
        properties: {
          step: {
            type: 'string',
            description: 'Short milestone name, such as "profile continuity checked"',
          },
          status: {
            type: 'string',
            enum: ['done', 'in_progress'],
            description: 'Whether the milestone is done or currently in progress',
          },
          evidence: {
            type: 'string',
            description: 'Concrete evidence showing what happened at this milestone',
          },
        },
        required: ['step', 'status', 'evidence'],
        additionalProperties: false,
      },
      execute: async (args) => this.recordTaskCheckpoint(args),
    });
  }

  private getAllTools(): Map<string, ToolDefinition> {
    return new Map([...this.tools, ...this.internalTools]);
  }

  private isInternalTaskSignalTool(name: string): boolean {
    return INTERNAL_TASK_TOOL_NAMES.has(name.trim() || name);
  }

  private async recordCompletionSignal(
    signal: 'complete' | 'blocked',
    args: Record<string, unknown>,
  ): Promise<ToolExecutionValue> {
    const state = this.currentAttemptCompletionState;
    if (!state) {
      return {
        output: 'No active turn is available for task completion tracking.',
        isError: true,
      };
    }

    const evidence = String(args.evidence ?? '').trim();
    if (!evidence) {
      return {
        output: 'A non-empty evidence field is required.',
        isError: true,
      };
    }

    if (signal === 'complete') {
      const summary = String(args.summary ?? '').trim();
      if (!summary) {
        return {
          output: 'A non-empty summary field is required.',
          isError: true,
        };
      }
      const hasVerifiedProgress =
        state.successfulExternalToolCount > 0 ||
        state.continuity.progressLedger.some((entry) => entry.source === 'tool' && !entry.isError);
      if (!hasVerifiedProgress) {
        return {
          output:
            'task_complete requires at least one successful external tool result in this turn.',
          isError: true,
        };
      }
      state.signal = 'complete';
      state.summary = summary;
      state.blocker = undefined;
      state.evidence = evidence;
    } else {
      const blocker = String(args.blocker ?? '').trim();
      if (!blocker) {
        return {
          output: 'A non-empty blocker field is required.',
          isError: true,
        };
      }
      state.signal = 'blocked';
      state.blocker = blocker;
      state.summary = undefined;
      state.evidence = evidence;
    }

    const boundarySummary =
      signal === 'complete'
        ? `Task completion recorded: ${state.summary}`
        : `Task blocker recorded: ${state.blocker}`;
    this.recordBoundary(state.continuity, {
      kind: 'completion',
      action: signal === 'complete' ? TASK_COMPLETE_TOOL : TASK_BLOCKED_TOOL,
      summary: boundarySummary,
      stateChanging: true,
      evidence,
    });
    this.appendTurnJournalEntry('completion_signal', boundarySummary, {
      signal,
      evidence,
      summary: state.summary,
      blocker: state.blocker,
    });

    this.emitCompletionTrace(
      'signal_recorded',
      signal === 'complete'
        ? `Recorded task_complete signal with evidence: ${evidence}`
        : `Recorded task_blocked signal with evidence: ${evidence}`,
      signal,
      'info',
    );

    return {
      output: signal === 'complete' ? 'Task completion recorded.' : 'Task blocker recorded.',
      isError: false,
      metadata: {
        internal: true,
        signal,
      },
    };
  }

  private async recordTaskCheckpoint(args: Record<string, unknown>): Promise<ToolExecutionValue> {
    const state = this.currentAttemptCompletionState;
    if (!state) {
      return {
        output: 'No active turn is available for task checkpoint tracking.',
        isError: true,
      };
    }

    const step = String(args.step ?? '').trim();
    const evidence = String(args.evidence ?? '').trim();
    const statusValue = String(args.status ?? '').trim();
    const status = statusValue === 'done' || statusValue === 'in_progress' ? statusValue : null;

    if (!step) {
      return {
        output: 'A non-empty step field is required.',
        isError: true,
      };
    }
    if (!status) {
      return {
        output: 'status must be either "done" or "in_progress".',
        isError: true,
      };
    }
    if (!evidence) {
      return {
        output: 'A non-empty evidence field is required.',
        isError: true,
      };
    }

    const checkpoint = this.recordCheckpoint(state.continuity, step, status, evidence);
    log.info('task_checkpoint_recorded', {
      turnId: this.currentStreamTurn?.turnId,
      attempt: this.currentStreamTurn?.attempt,
      conversationId: this.currentStreamTurn?.conversationId,
      step,
      status,
      evidence,
    });

    return {
      output: `Checkpoint recorded: ${checkpoint.summary}`,
      isError: false,
      metadata: {
        internal: true,
        checkpoint,
      },
    };
  }

  registerTool(name: string, tool: ToolDefinition): void {
    if (this.internalTools.has(name)) {
      throw new Error(`Tool name ${name} is reserved for internal task signaling`);
    }
    this.tools.set(name, tool);
  }

  registerTools(tools: Record<string, ToolDefinition>): void {
    for (const [name, tool] of Object.entries(tools)) {
      this.registerTool(name, tool);
    }
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    options?: {
      conversationId?: string;
      sessionKey?: string;
      scopeKey?: string;
      callId?: string;
      turnId?: string;
      attempt?: number;
    },
  ): Promise<{ toolName: string; result: ToolResult }> {
    return this.toolRuntime.execute({
      toolCall: {
        id: options?.callId ?? nanoid(10),
        name,
        args,
      },
      tools: this.getAllTools(),
      conversationId: options?.conversationId,
      sessionKey: options?.sessionKey,
      scopeKey: options?.scopeKey,
      turnId: options?.turnId,
      attempt: options?.attempt,
    });
  }

  unregisterTool(name: string): boolean {
    if (this.internalTools.has(name)) {
      return false;
    }
    return this.tools.delete(name);
  }

  setProfile(profile: { name: string; role: string; traits: string[] }): void {
    this.profile = profile;
  }

  setInstanceStore(store: InstanceStore): void {
    this.instanceStore = store;
  }

  getInstanceStore(): InstanceStore | null {
    return this.instanceStore;
  }

  setProactiveEnabled(enabled: boolean): void {
    this.proactiveEnabled = enabled;
  }

  setDiscoveryMode(enabled: boolean): void {
    this.discoveryMode = enabled;
    log.info('Discovery mode changed', { enabled });
  }

  isDiscoveryMode(): boolean {
    return this.discoveryMode;
  }

  setDiscoveryCompleteHandler(
    handler: (result: { name: string; role: string; traits: string[] }) => void,
  ): void {
    this.onDiscoveryComplete = handler;
  }

  sendProactiveMessage(content: string, source: string): void {
    this.emit({ type: 'message:proactive', content, source });
  }

  setAutoMode(enabled: boolean): void {
    this.autoMode = enabled;
    log.info('Auto mode changed', { autoMode: enabled });
  }

  getAutoMode(): boolean {
    return this.autoMode;
  }

  setGatewayMode(
    mode: 'standalone' | 'gateway' | 'node',
    extras?: { connectedNodes?: number; gatewayUrl?: string },
  ): void {
    this.gatewayMode = mode;
    if (extras?.connectedNodes !== undefined) this.connectedNodes = extras.connectedNodes;
    if (extras?.gatewayUrl !== undefined) this.gatewayUrl = extras.gatewayUrl;
  }

  emergencyStop(): void {
    // 1. Abort current stream
    this.abortController?.abort();
    this.abortController = null;

    // 2. Cancel all sub-agents
    if (this.subAgentManager) {
      const agents = this.subAgentManager.listAgents();
      agents
        .filter((a) => a.status === 'running' || a.status === 'pending')
        .forEach((a) => this.subAgentManager!.cancel(a.id));
    }

    // 3. Emit event
    this.emit({ type: 'emergency:stop' });
    log.warn('Emergency stop triggered');
  }

  /** Set a callback that provides training pairs for fine-tuning (from HippocampusCurator). */
  setFineTuneDataProvider(provider: () => Promise<TrainingPair[]>, method = 'auto'): void {
    this.fineTuneDataProvider = provider;
    this.fineTuneMethod = method;
  }

  getFineTuneMethod(): string {
    return this.fineTuneMethod;
  }

  setFineTuneMethod(method: string): void {
    this.fineTuneMethod = method;
  }

  getFineTuneSchedule(): string {
    return this.fineTuneSchedule;
  }

  setFineTuneSchedule(schedule: string): void {
    this.fineTuneSchedule = schedule;
  }

  /** Get current fine-tune status from Cerebellum (or cached local state). */
  async getFineTuneStatus(): Promise<FineTuneStatus> {
    if (this.cerebellum?.getFineTuneStatus) {
      try {
        const remote = await this.cerebellum.getFineTuneStatus();
        if (remote) {
          this.fineTuneStatus = remote;
          return remote;
        }
      } catch {
        // Fall back to local cache
      }
    }
    return this.fineTuneStatus;
  }

  getFineTuneHistory(): Array<{
    jobId: string;
    status: string;
    completedAt: number;
    loss: number;
  }> {
    return this._fineTuneHistory;
  }

  /** Minimum training pairs required before starting a fine-tune run. */
  static readonly MIN_TRAINING_PAIRS = 5;

  /** Trigger a fine-tuning run: collect training data, send to cerebellum, start training, poll progress. */
  async triggerFineTune(): Promise<void> {
    if (!this.cerebellum?.ingestTrainingData || !this.cerebellum?.startFineTune) {
      throw new Error('Cerebellum fine-tuning not available');
    }

    // 1. Collect training data
    let pairs: TrainingPair[] = [];
    if (this.fineTuneDataProvider) {
      pairs = await this.fineTuneDataProvider();
    }

    // 2. Ingest training data
    let totalPending = 0;
    if (pairs.length > 0) {
      totalPending = await this.cerebellum.ingestTrainingData(pairs);
      log.info('Training data ingested', { newPairs: pairs.length, totalPending });
    }

    // 3. Check minimum threshold
    if (totalPending < Orchestrator.MIN_TRAINING_PAIRS) {
      log.info('Not enough training data, deferring fine-tune', {
        totalPending,
        threshold: Orchestrator.MIN_TRAINING_PAIRS,
      });
      throw new Error(
        `Not enough training data (${totalPending}/${Orchestrator.MIN_TRAINING_PAIRS} pairs). ` +
          'Data has been saved — training will start automatically when enough accumulates.',
      );
    }

    // 4. Start fine-tuning
    const result = await this.cerebellum.startFineTune({ method: this.fineTuneMethod });
    if (!result.started) {
      throw new Error(result.error || 'Failed to start fine-tuning');
    }

    this.fineTuneStatus = {
      ...this.fineTuneStatus,
      status: 'running',
      jobId: result.jobId,
      startedAt: Date.now(),
    };
    this.emit({ type: 'finetune:start', jobId: result.jobId });
    log.info('Fine-tuning started', { jobId: result.jobId });

    // 5. Poll for progress
    this.stopFineTunePoller();
    this.fineTunePoller = setInterval(async () => {
      try {
        const status = await this.cerebellum!.getFineTuneStatus!();
        if (!status) return;

        this.fineTuneStatus = status;

        if (status.status === 'running') {
          this.emit({
            type: 'finetune:progress',
            jobId: status.jobId,
            progress: status.progress,
            loss: status.currentLoss,
          });
        } else if (status.status === 'completed') {
          this._fineTuneHistory.push({
            jobId: status.jobId,
            status: 'completed',
            completedAt: status.completedAt || Date.now(),
            loss: status.currentLoss,
          });
          this.instanceStore?.recordFineTune({
            jobId: status.jobId,
            method: this.fineTuneMethod,
            completedAt: new Date(status.completedAt || Date.now()).toISOString(),
            checkpointPath: status.checkpointPath,
            loss: status.currentLoss,
            trainingPairs: status.totalSteps,
          });
          this.emit({
            type: 'finetune:complete',
            jobId: status.jobId,
            checkpointPath: status.checkpointPath,
          });
          log.info('Fine-tuning completed', {
            jobId: status.jobId,
            checkpoint: status.checkpointPath,
          });
          this.stopFineTunePoller();
        } else if (status.status === 'failed') {
          this._fineTuneHistory.push({
            jobId: status.jobId,
            status: 'failed',
            completedAt: Date.now(),
            loss: status.currentLoss,
          });
          this.emit({
            type: 'finetune:error',
            jobId: status.jobId,
            error: status.error,
          });
          log.error('Fine-tuning failed', { jobId: status.jobId, error: status.error });
          this.stopFineTunePoller();
        }
      } catch {
        // Polling failure is non-blocking
      }
    }, 10_000);
  }

  private stopFineTunePoller(): void {
    if (this.fineTunePoller) {
      clearInterval(this.fineTunePoller);
      this.fineTunePoller = null;
    }
  }

  private parseDiscoveryCompletion(
    text: string,
  ): { name: string; role: string; traits: string[] } | null {
    const match = text.match(/<discovery_complete>\s*([\s\S]*?)\s*<\/discovery_complete>/);
    if (!match) return null;
    const block = match[1];
    const nameMatch = block.match(/name:\s*(.+)/i);
    const roleMatch = block.match(/role:\s*(.+)/i);
    const traitsMatch = block.match(/traits:\s*(.+)/i);
    return {
      name: nameMatch?.[1]?.trim() || 'Cere',
      role: roleMatch?.[1]?.trim() || 'general-purpose assistant',
      traits:
        traitsMatch?.[1]
          ?.split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean) ?? [],
    };
  }

  getActiveConversationId(): string | null {
    return this.activeConversationId;
  }

  getConversation(id: string) {
    return this.conversations.get(id);
  }

  getMessages(conversationId?: string): Message[] {
    const id = conversationId ?? this.activeConversationId;
    if (!id) return [];
    return this.conversations.getMessages(id);
  }

  getQuerySession(conversationId: string, sessionId: string): QuerySession | undefined {
    return this.conversations.getQuerySession(conversationId, sessionId);
  }

  getSessionEvents(conversationId: string, sessionId: string): SessionEvent[] {
    return this.conversations.getSessionEvents(conversationId, sessionId);
  }

  recordSessionEvent(
    conversationId: string,
    sessionId: string,
    type: SessionEventType,
    summary: string,
    data?: Record<string, unknown>,
  ): void {
    const session = this.conversations.getQuerySession(conversationId, sessionId);
    if (!session) return;

    const updatedAt = Date.now();
    const updatedSession: QuerySession = {
      ...session,
      updatedAt,
      summary: this.truncateResumeText(summary, 500),
    };
    this.conversations.saveQuerySession(conversationId, updatedSession);

    const event: SessionEvent = {
      sessionId,
      conversationId,
      turnId: session.turnId,
      attempt: session.attempt,
      timestamp: updatedAt,
      type,
      state: updatedSession.state,
      summary: this.truncateResumeText(summary, 500),
      instanceId: updatedSession.instanceId,
      checkpointPath: updatedSession.checkpointPath ?? null,
      data,
    };
    this.conversations.appendSessionEvent(conversationId, sessionId, event);
  }

  recordSessionMemoryUpdate(
    conversationId: string,
    sessionId: string,
    snapshot: SessionMemorySnapshot,
  ): void {
    const session = this.conversations.getQuerySession(conversationId, sessionId);
    if (!session) return;

    const updated: QuerySession = {
      ...session,
      memory: snapshot,
      updatedAt: Date.now(),
      summary: snapshot.summary || session.summary,
    };
    this.conversations.saveQuerySession(conversationId, updated);

    const event: SessionEvent = {
      sessionId,
      conversationId,
      turnId: session.turnId,
      attempt: session.attempt,
      timestamp: snapshot.updatedAt,
      type: 'memory_updated',
      state: updated.state,
      summary: this.truncateResumeText(`Session memory updated: ${snapshot.summary}`, 500),
      instanceId: updated.instanceId,
      checkpointPath: updated.checkpointPath ?? null,
      data: {
        excerpt: snapshot.excerpt,
      },
    };
    this.conversations.appendSessionEvent(conversationId, sessionId, event);
    this.emit({ type: 'session:memory-updated', conversationId, sessionId, snapshot });
  }

  startConversation(): string {
    const conversation = this.conversations.create();
    this.activeConversationId = conversation.id;
    this.instanceStore?.incrementConversation();
    log.info('Started conversation', { id: conversation.id });
    return conversation.id;
  }

  /** Resume an existing conversation by ID */
  resumeConversation(id: string): boolean {
    const conversation = this.conversations.get(id);
    if (!conversation) return false;
    this.activeConversationId = id;
    const messages = this.conversations.getMessages(id);
    this.emit({ type: 'conversation:resumed', conversationId: id, messages });
    log.info('Resumed conversation', { id, messageCount: messages.length });
    return true;
  }

  // --- Recurring Task Execution ---

  setRecurringTasks(tasks: Array<{ id: string; goal: string; schedule: string }>): void {
    this.recurringTasks = tasks;
  }

  setTaskConversation(taskId: string, conversationId: string): void {
    this.taskConversations.set(taskId, conversationId);
  }

  getTaskConversation(taskId: string): string | undefined {
    return this.taskConversations.get(taskId);
  }

  isTaskRunning(taskId: string): boolean {
    return this.taskRunning.has(taskId);
  }

  async runTask(
    taskId: string,
    goal: string,
    options?: { timeoutMs?: number; autoMode?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    if (this.taskRunning.has(taskId)) {
      return { success: false, error: 'Task already running' };
    }

    // Get or create a dedicated conversation for this task
    let convId = this.taskConversations.get(taskId);
    if (!convId || !this.conversations.get(convId)) {
      const conv = this.conversations.create();
      convId = conv.id;
      this.taskConversations.set(taskId, convId);
    }

    const prevAutoMode = this.autoMode;
    if (options?.autoMode !== undefined) {
      this.autoMode = options.autoMode;
    }

    this.taskRunning.add(taskId);
    this.emit({ type: 'task:start', taskId, goal });
    log.info('Running recurring task', { taskId, conversationId: convId });

    const timeoutMs = options?.timeoutMs ?? 600_000;

    try {
      const now = new Date().toISOString();
      const taskDef = this.recurringTasks.find((t) => t.id === taskId);
      const schedule = taskDef?.schedule ?? 'unknown';
      const prompt = [
        `[Recurring Task: ${taskId}]`,
        `Schedule: ${schedule}`,
        `Current time: ${now}`,
        `Goal: ${goal}`,
        '',
        'Execute this goal using your available tools and skills.',
        'Review your conversation history for learnings from previous runs.',
        'If a step fails, try an alternative approach before giving up.',
        'After completing, use memory_log to record what you did, outcomes, and any issues.',
      ].join('\n');

      await Promise.race([
        this.sendMessage(prompt, convId),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Task timed out after ${timeoutMs / 1000}s`)),
            timeoutMs,
          ),
        ),
      ]);

      this.emit({ type: 'task:complete', taskId });
      log.info('Recurring task completed', { taskId });
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'task:error', taskId, error });
      log.warn('Recurring task failed', { taskId, error });
      return { success: false, error };
    } finally {
      this.taskRunning.delete(taskId);
      this.autoMode = prevAutoMode;
    }
  }

  getStreamState(): StreamState {
    const stallThresholdMs = this.getCurrentStallThresholdMs();
    return {
      streaming: this.streamWatchdog !== null,
      lastActivityAt: this.lastStreamActivityAt,
      stallDetected:
        this.streamWatchdog !== null && Date.now() - this.lastStreamActivityAt > stallThresholdMs,
      nudgeCount: this.streamNudgeCount,
      phase: this.streamPhase,
      activeToolName: this.activeToolCall?.name,
      activeToolCallId: this.activeToolCall?.id,
      activeToolStartedAt: this.activeToolCall?.startedAt,
    };
  }

  private markStreamWaitingModel(activityAt = Date.now()): void {
    const phaseChanged = this.streamPhase !== 'waiting_model' || this.activeToolCall !== null;
    this.lastStreamActivityAt = activityAt;
    this.streamPhase = 'waiting_model';
    this.activeToolCall = null;
    if (phaseChanged) {
      this.logStreamDebug('stream_phase_changed', {
        phase: this.streamPhase,
      });
    }
  }

  private markStreamWaitingTool(toolCall: ToolCall, activityAt = Date.now()): void {
    const normalizedToolName = toolCall.name.trim() || toolCall.name;
    const phaseChanged =
      this.streamPhase !== 'waiting_tool' ||
      this.activeToolCall?.id !== toolCall.id ||
      this.activeToolCall?.name !== normalizedToolName;
    this.lastStreamActivityAt = activityAt;
    this.streamPhase = 'waiting_tool';
    this.activeToolCall = {
      id: toolCall.id,
      name: normalizedToolName,
      startedAt: activityAt,
    };
    if (phaseChanged) {
      this.logStreamDebug('stream_phase_changed', {
        phase: this.streamPhase,
        activeToolName: normalizedToolName,
        activeToolCallId: toolCall.id,
      });
    }
  }

  private resetStreamState(): void {
    this.streamPhase = 'idle';
    this.activeToolCall = null;
    this.streamDeferredUntil = 0;
    this.currentPartialContent = '';
    this.currentLastContentKind = 'empty';
    this.currentJournaledContentLength = 0;
  }

  private createQuerySession(
    conversationId: string,
    turnId: string,
    attempt: number,
    source: SessionSource,
    latestUserMessage: string,
    stallRetryCount: number,
    completionRetryCount: number,
    priorSession?: QuerySession | null,
  ): QuerySession {
    const timestamp = Date.now();
    const instance = this.instanceStore?.get();
    return {
      id: turnId,
      conversationId,
      turnId,
      attempt,
      source,
      state: 'ready',
      startedAt: timestamp,
      updatedAt: timestamp,
      summary: `Turn attempt ${attempt} started.`,
      latestUserMessage: this.truncateResumeText(latestUserMessage, 1200),
      stallRetryCount,
      completionRetryCount,
      instanceId: instance?.id,
      checkpointPath: instance?.activeCheckpoint ?? null,
      // Carry forward recovery state from prior attempt for crash recovery
      ...(priorSession?.latestBoundary ? { latestBoundary: priorSession.latestBoundary } : {}),
      ...(priorSession?.lastOutcome ? { lastOutcome: priorSession.lastOutcome } : {}),
      ...(priorSession?.lastError ? { lastError: priorSession.lastError } : {}),
    };
  }

  private saveCurrentQuerySession(): void {
    if (!this.currentStreamTurn || !this.currentQuerySession) return;
    this.conversations.saveQuerySession(
      this.currentStreamTurn.conversationId,
      this.currentQuerySession,
    );
  }

  private updateCurrentQuerySession(
    type: TurnJournalEntryType,
    summary: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.currentStreamTurn || !this.currentQuerySession) return;

    const eventState = this.getQuerySessionState(type, data);
    const updatedAt = Date.now();
    const next: QuerySession = {
      ...this.currentQuerySession,
      attempt: this.currentStreamTurn.attempt,
      updatedAt,
      summary: this.truncateResumeText(summary, 500),
      state: this.resolveQuerySessionState(type, eventState, data),
      checkpointPath: this.instanceStore?.get()?.activeCheckpoint ?? this.currentQuerySession.checkpointPath ?? null,
    };

    if (type === 'partial_text') {
      const excerpt = typeof data?.excerpt === 'string' ? data.excerpt : summary;
      next.latestAssistantMessage = this.truncateResumeText(excerpt, 1200);
    }
    if (type === 'tool_start') {
      next.activeToolName = typeof data?.toolName === 'string' ? data.toolName : undefined;
      next.activeToolCallId = typeof data?.callId === 'string' ? data.callId : undefined;
    } else if (type !== 'tool_end') {
      next.activeToolName = undefined;
      next.activeToolCallId = undefined;
    }
    if (type === 'tool_end') {
      next.activeToolName = undefined;
      next.activeToolCallId = undefined;
    }
    if (type === 'turn_finished') {
      const finalContent = typeof data?.finalContent === 'string' ? data.finalContent.trim() : '';
      if (finalContent) {
        next.latestAssistantMessage = this.truncateResumeText(finalContent, 1200);
      }
      if (typeof data?.turnOutcome === 'string') {
        next.lastOutcome = data.turnOutcome as TurnOutcome;
      }
    }
    if (type === 'turn_error') {
      next.lastError = typeof data?.error === 'string' ? data.error : summary;
      if (data?.aborted === true) {
        next.lastOutcome = 'aborted';
      } else {
        next.lastOutcome = 'protocol_error';
      }
    }
    if (type === 'completion_signal' && typeof data?.signal === 'string') {
      next.summary = this.truncateResumeText(summary, 500);
    }

    this.currentQuerySession = next;
    this.saveCurrentQuerySession();
  }

  private resolveQuerySessionState(
    type: TurnJournalEntryType,
    defaultState: QuerySessionState,
    data?: Record<string, unknown>,
  ): QuerySessionState {
    if (type === 'turn_finished') {
      const turnOutcome = data?.turnOutcome;
      if (turnOutcome === 'completed' || turnOutcome === 'completed_no_text') return 'completed';
      if (turnOutcome === 'stalled') return 'stalled';
      if (turnOutcome === 'aborted') return 'aborted';
      if (turnOutcome === 'ended_on_tool_calls' || turnOutcome === 'completion_signal_missing') {
        return 'waiting_followup';
      }
      if (turnOutcome === 'protocol_error') return 'failed';
    }
    return defaultState;
  }

  private appendTurnJournalEntry(
    type: TurnJournalEntryType,
    summary: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.currentStreamTurn) return;

    const entry: TurnJournalEntry = {
      turnId: this.currentStreamTurn.turnId,
      attempt: this.currentStreamTurn.attempt,
      timestamp: Date.now(),
      type,
      summary: this.truncateResumeText(summary, 500),
      ...(data ? { data } : {}),
    };
    this.conversations.appendTurnJournalEntry(
      this.currentStreamTurn.conversationId,
      this.currentStreamTurn.turnId,
      entry,
    );
    this.appendSessionEvent(type, entry.summary, data);
  }

  private appendSessionEvent(
    type: TurnJournalEntryType,
    summary: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.currentStreamTurn) return;

    const instance = this.instanceStore?.get();
    const event: SessionEvent = {
      sessionId: this.currentStreamTurn.sessionId,
      conversationId: this.currentStreamTurn.conversationId,
      turnId: this.currentStreamTurn.turnId,
      attempt: this.currentStreamTurn.attempt,
      timestamp: Date.now(),
      type: this.mapJournalEntryToSessionEvent(type),
      state: this.getQuerySessionState(type, data),
      summary: this.truncateResumeText(summary, 500),
      instanceId: instance?.id,
      checkpointPath: instance?.activeCheckpoint ?? null,
      ...(data ? { data } : {}),
    };
    this.conversations.appendSessionEvent(
      this.currentStreamTurn.conversationId,
      this.currentStreamTurn.sessionId,
      event,
    );
    this.updateCurrentQuerySession(type, summary, data);
  }

  private mapJournalEntryToSessionEvent(type: TurnJournalEntryType): SessionEventType {
    switch (type) {
      case 'tool_start':
        return 'tool_started';
      case 'tool_end':
        return 'tool_finished';
      case 'checkpoint':
        return 'checkpoint_recorded';
      case 'boundary':
        return 'boundary_committed';
      case 'completion_signal':
        return 'completion_signal_recorded';
      case 'recovery':
        return 'recovery_assessed';
      case 'turn_error':
        return 'turn_failed';
      default:
        return type;
    }
  }

  private getQuerySessionState(
    type: TurnJournalEntryType,
    data?: Record<string, unknown>,
  ): QuerySessionState {
    switch (type) {
      case 'turn_started':
        return 'ready';
      case 'partial_text':
        return 'sampling';
      case 'tool_start':
        return 'tool_execution';
      case 'tool_end':
      case 'checkpoint':
      case 'boundary':
      case 'completion_signal':
        return 'waiting_followup';
      case 'recovery':
        return data?.cause === 'stall' ? 'stalled' : 'waiting_followup';
      case 'turn_finished':
        return 'completed';
      case 'turn_error':
        return data?.aborted ? 'aborted' : 'failed';
      default:
        return 'waiting_followup';
    }
  }

  private pruneTurnJournals(conversationId: string): void {
    try {
      const result = this.conversations.pruneTurnJournals(
        conversationId,
        this.turnJournalRetention,
      );
      if (result.prunedByAge > 0 || result.prunedByCount > 0) {
        log.debug('Pruned turn journals', {
          conversationId,
          prunedByAge: result.prunedByAge,
          prunedByCount: result.prunedByCount,
          remaining: result.remaining,
        });
      }
    } catch (error) {
      log.warn('Failed to prune turn journals', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persistPartialContentSnapshot(force = false): void {
    const normalized = this.currentPartialContent.trim();
    if (!normalized) return;
    if (!force && this.currentPartialContent.length - this.currentJournaledContentLength < 200) {
      return;
    }
    this.currentJournaledContentLength = this.currentPartialContent.length;
    this.appendTurnJournalEntry(
      'partial_text',
      `Assistant partial text: ${this.truncateResumeText(normalized, 220)}`,
      {
        chars: this.currentPartialContent.length,
        excerpt: this.truncateResumeText(normalized, 1200),
      },
    );
  }

  private recordBoundary(
    continuity: TurnContinuityState,
    boundary: Omit<TurnBoundarySummary, 'id' | 'createdAt' | 'browserState'> & {
      browserState?: BrowserStateSnapshot;
    },
  ): TurnBoundarySummary {
    const createdAt = Date.now();
    const summary: TurnBoundarySummary = {
      id: nanoid(10),
      createdAt,
      browserState: this.cloneBrowserState(boundary.browserState ?? continuity.browserState),
      ...boundary,
    };

    continuity.boundaries.push(summary);
    while (continuity.boundaries.length > 20) {
      continuity.boundaries.shift();
    }

    this.appendTurnJournalEntry('boundary', summary.summary, {
      boundaryId: summary.id,
      kind: summary.kind,
      action: summary.action,
      stateChanging: summary.stateChanging,
      url: summary.url,
      tabId: summary.tabId,
      checkpointStatus: summary.checkpointStatus,
      evidence: summary.evidence,
      browserState: summary.browserState,
    });

    if (this.currentQuerySession) {
      this.currentQuerySession = {
        ...this.currentQuerySession,
        latestBoundary: summary,
        updatedAt: Date.now(),
      };
      this.saveCurrentQuerySession();
    }

    return summary;
  }

  private deriveRepetitionSignals(continuity: TurnContinuityState): string[] {
    const signals: string[] = [];
    const recentToolEntries = continuity.progressLedger
      .filter((entry) => entry.source === 'tool')
      .slice(-10);
    const recentActions = recentToolEntries.map((entry) => entry.action);
    if (recentActions.length >= 4 && new Set(recentActions.slice(-4)).size <= 2) {
      signals.push(
        `Recent tool actions are cycling between ${Array.from(new Set(recentActions.slice(-4))).join(', ')}`,
      );
    }

    const summaryCounts = new Map<string, number>();
    for (const boundary of continuity.boundaries.slice(-12)) {
      if (boundary.kind !== 'tool' || !boundary.stateChanging) continue;
      const key = `${boundary.action}|${boundary.summary}`;
      summaryCounts.set(key, (summaryCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of summaryCounts.entries()) {
      if (count < 2) continue;
      const [, summary] = key.split('|', 2);
      signals.push(`Repeated verified action x${count}: ${summary}`);
    }

    return signals.slice(0, 5);
  }

  private classifyTurnOutcome(
    displayContent: string,
    finishMeta: StreamFinishMetadata | undefined,
    completionState: AttemptCompletionState,
  ): TurnOutcome {
    const trimmed = displayContent.trim();
    const endedOnToolCalls =
      finishMeta?.finishReason === 'tool-calls' ||
      finishMeta?.stepFinishReasons.at(-1) === 'tool-calls' ||
      finishMeta?.endedWithToolCall === true;

    if (endedOnToolCalls) {
      return 'ended_on_tool_calls';
    }
    if (completionState.externalToolCallCount > 0 && completionState.signal === 'none') {
      return 'completion_signal_missing';
    }
    if (finishMeta?.finishReason === 'error' || finishMeta?.lastContentKind === 'error') {
      return 'protocol_error';
    }
    if (trimmed.length > 0) {
      return 'completed';
    }
    return 'completed_no_text';
  }

  private getStreamDiagnostics(elapsedSeconds?: number): {
    elapsedSeconds?: number;
    phase: StreamPhase;
    activeToolName?: string;
    activeToolCallId?: string;
    activeToolStartedAt?: number;
  } {
    return {
      elapsedSeconds,
      phase: this.streamPhase,
      activeToolName: this.activeToolCall?.name,
      activeToolCallId: this.activeToolCall?.id,
      activeToolStartedAt: this.activeToolCall?.startedAt,
    };
  }

  private describeStreamLocation(
    phase = this.streamPhase,
    activeToolName = this.activeToolCall?.name,
  ): string {
    if (phase === 'waiting_tool') {
      return activeToolName ? `waiting_tool/${activeToolName}` : 'waiting_tool';
    }
    return phase;
  }

  private getCurrentStallThresholdMs(
    phase = this.streamPhase,
    nudgeCount = this.streamNudgeCount,
  ): number {
    const phaseBase =
      phase === 'waiting_model' ? this.streamStallThreshold * 3 : this.streamStallThreshold;
    return phaseBase + nudgeCount * this.streamStallThreshold;
  }

  private logStreamDebug(msg: string, data?: Record<string, unknown>): void {
    if (!this.currentStreamTurn) return;
    log.debug(msg, {
      turnId: this.currentStreamTurn.turnId,
      attempt: this.currentStreamTurn.attempt,
      conversationId: this.currentStreamTurn.conversationId,
      ...data,
    });
  }

  private emitWatchdog(
    stage: WatchdogStage,
    message: string,
    options?: {
      level?: 'debug' | 'info' | 'warn' | 'error';
      elapsedSeconds?: number;
    },
  ): void {
    if (!this.currentStreamTurn) return;

    const payload = {
      stage,
      turnId: this.currentStreamTurn.turnId,
      attempt: this.currentStreamTurn.attempt,
      conversationId: this.currentStreamTurn.conversationId,
      message,
      ...this.getStreamDiagnostics(options?.elapsedSeconds),
    };

    const level = options?.level ?? 'info';
    switch (level) {
      case 'debug':
        log.debug(`watchdog_${stage}`, payload);
        break;
      case 'warn':
        log.warn(`watchdog_${stage}`, payload);
        break;
      case 'error':
        log.error(`watchdog_${stage}`, payload);
        break;
      default:
        log.info(`watchdog_${stage}`, payload);
        break;
    }

    this.emit({ type: 'cerebrum:watchdog', ...payload });
  }

  private emitCompletionTrace(
    stage:
      | 'signal_recorded'
      | 'guard_triggered'
      | 'retry_started'
      | 'retry_recovered'
      | 'retry_failed',
    message: string,
    signal: CompletionSignal,
    level: 'debug' | 'info' | 'warn' | 'error' = 'info',
  ): void {
    if (!this.currentStreamTurn) return;

    const payload = {
      stage,
      turnId: this.currentStreamTurn.turnId,
      attempt: this.currentStreamTurn.attempt,
      conversationId: this.currentStreamTurn.conversationId,
      signal,
      message,
      ...this.getStreamDiagnostics(),
    };

    switch (level) {
      case 'debug':
        log.debug(`completion_${stage}`, payload);
        break;
      case 'warn':
        log.warn(`completion_${stage}`, payload);
        break;
      case 'error':
        log.error(`completion_${stage}`, payload);
        break;
      default:
        log.info(`completion_${stage}`, payload);
        break;
    }

    this.emit({ type: 'cerebrum:completion', ...payload });
  }

  private createAttemptCompletionState(continuity: TurnContinuityState): AttemptCompletionState {
    return {
      signal: 'none',
      evidence: '',
      successfulExternalToolCount: 0,
      externalToolCallCount: 0,
      internalToolCallCount: 0,
      continuity,
    };
  }

  private createTurnContinuityState(): TurnContinuityState {
    return {
      progressLedger: [],
      taskCheckpoints: [],
      browserState: {},
      boundaries: [],
    };
  }

  private buildRecoveryRequest(params: {
    cause: RecoveryCause;
    attempt: number;
    partialContent: string;
    completionState: AttemptCompletionState;
    turnOutcome: TurnOutcome;
    latestUserMessage?: string;
    elapsedSeconds?: number;
    completionRetryCount?: number;
    finishMeta?: StreamFinishMetadata;
  }): TurnRecoveryRequest {
    const partialContent = this.truncateResumeText(params.partialContent, 600);
    const continuity = params.completionState.continuity;
    const latestBoundary = continuity.boundaries.at(-1);
    return {
      conversationId: this.currentStreamTurn?.conversationId ?? '',
      turnId: this.currentStreamTurn?.turnId ?? '',
      attempt: params.attempt,
      cause: params.cause,
      phase: this.streamPhase,
      activeToolName: this.activeToolCall?.name,
      activeToolCallId: this.activeToolCall?.id,
      stallRetryCount: this.streamNudgeCount,
      completionRetryCount: params.completionRetryCount ?? 0,
      finishReason: params.finishMeta?.finishReason ?? params.finishMeta?.stepFinishReasons.at(-1),
      turnOutcome: params.turnOutcome,
      lastContentKind: params.finishMeta?.lastContentKind ?? this.currentLastContentKind,
      elapsedSeconds: params.elapsedSeconds,
      partialContent: partialContent || undefined,
      latestUserMessage: params.latestUserMessage
        ? this.truncateResumeText(params.latestUserMessage, 600)
        : undefined,
      progressEntries: continuity.progressLedger.slice(-50).map((entry) => ({ ...entry })),
      taskCheckpoints: continuity.taskCheckpoints.map((checkpoint) => ({ ...checkpoint })),
      browserState: this.cloneBrowserState(continuity.browserState),
      latestBoundary: latestBoundary
        ? {
            ...latestBoundary,
            ...(latestBoundary.browserState
              ? { browserState: this.cloneBrowserState(latestBoundary.browserState) }
              : {}),
          }
        : undefined,
      recentBoundaries: continuity.boundaries.slice(-20).map((boundary) => ({
        ...boundary,
        ...(boundary.browserState
          ? { browserState: this.cloneBrowserState(boundary.browserState) }
          : {}),
      })),
      repetitionSignals: this.deriveRepetitionSignals(continuity),
    };
  }

  private emitRecoveryTrace(
    cause: RecoveryCause,
    source: RecoverySource,
    assessment: TurnRecoveryAssessment,
    level: 'debug' | 'info' | 'warn' | 'error' = 'info',
  ): void {
    if (!this.currentStreamTurn) return;

    const payload = {
      type: 'cerebellum:recovery' as const,
      cause,
      action: assessment.action,
      turnId: this.currentStreamTurn.turnId,
      attempt: this.currentStreamTurn.attempt,
      conversationId: this.currentStreamTurn.conversationId,
      message: assessment.operatorMessage,
      operatorMessage: assessment.operatorMessage,
      diagnosis: assessment.diagnosis,
      nextStep: assessment.nextStep,
      completedSteps: assessment.completedSteps,
      waitSeconds: assessment.waitSeconds,
      source,
      ...this.getStreamDiagnostics(),
    };

    switch (level) {
      case 'debug':
        log.debug('cerebellum_recovery', payload);
        break;
      case 'warn':
        log.warn('cerebellum_recovery', payload);
        break;
      case 'error':
        log.error('cerebellum_recovery', payload);
        break;
      default:
        log.info('cerebellum_recovery', payload);
        break;
    }

    this.emit(payload);
  }

  private async assessTurnRecovery(
    request: TurnRecoveryRequest,
  ): Promise<{ source: RecoverySource; assessment: TurnRecoveryAssessment }> {
    log.debug('turn_recovery_request', {
      turnId: request.turnId,
      attempt: request.attempt,
      conversationId: request.conversationId,
      cause: request.cause,
      phase: request.phase,
      activeToolName: request.activeToolName,
      activeToolCallId: request.activeToolCallId,
      stallRetryCount: request.stallRetryCount,
      completionRetryCount: request.completionRetryCount,
      finishReason: request.finishReason,
      turnOutcome: request.turnOutcome,
      lastContentKind: request.lastContentKind,
      elapsedSeconds: request.elapsedSeconds,
      hasPartialContent: Boolean(request.partialContent),
      latestUserMessage: request.latestUserMessage
        ? this.truncateResumeText(request.latestUserMessage, 300)
        : '',
      browserState: request.browserState,
      progressEntries: request.progressEntries,
      taskCheckpoints: request.taskCheckpoints,
      latestBoundary: request.latestBoundary,
      recentBoundaries: request.recentBoundaries,
      repetitionSignals: request.repetitionSignals,
    });

    if (this.cerebellum?.isConnected() && this.cerebellum.assessTurnRecovery) {
      try {
        const assessment = await this.cerebellum.assessTurnRecovery(request);
        if (assessment) {
          if (request.cause === 'completion' && assessment.action === 'wait') {
            return {
              source: 'cerebellum',
              assessment: {
                ...assessment,
                action: 'retry',
                waitSeconds: undefined,
              },
            };
          }
          return { source: 'cerebellum', assessment };
        }
      } catch (error) {
        log.warn('Turn recovery assessment failed', {
          turnId: request.turnId,
          attempt: request.attempt,
          conversationId: request.conversationId,
          cause: request.cause,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      source: 'fallback',
      assessment: this.buildFallbackRecoveryAssessment(request),
    };
  }

  private deriveCompletedSteps(request: TurnRecoveryRequest): string[] {
    const completed = new Set<string>();
    for (const boundary of request.recentBoundaries) {
      if (
        (boundary.kind === 'tool' ||
          boundary.kind === 'checkpoint' ||
          boundary.kind === 'completion') &&
        boundary.summary
      ) {
        completed.add(boundary.summary);
      }
    }
    for (const checkpoint of request.taskCheckpoints) {
      if (checkpoint.status === 'done') {
        completed.add(checkpoint.summary);
      }
    }

    for (const entry of request.progressEntries) {
      if (entry.source === 'tool' && entry.stateChanging && !entry.isError) {
        completed.add(entry.summary);
      }
    }

    return Array.from(completed).slice(-10);
  }

  private buildFallbackRecoveryAssessment(
    request: TurnRecoveryRequest,
    options?: { reason?: string; action?: RecoveryAction },
  ): TurnRecoveryAssessment {
    const completedSteps = this.deriveCompletedSteps(request);
    const browserHints: string[] = [];
    if (request.browserState.currentUrl)
      browserHints.push(`Current URL: ${request.browserState.currentUrl}`);
    if (request.browserState.activeTabId)
      browserHints.push(`Active tab: ${request.browserState.activeTabId}`);

    const diagnosis =
      options?.reason ??
      (request.cause === 'stall'
        ? `Recovery guidance is unavailable while the stream is stalled in ${this.describeStreamLocation(request.phase, request.activeToolName)}.`
        : `Recovery guidance is unavailable after the turn ended with ${request.turnOutcome} (${request.finishReason ?? 'no final answer'}).`);
    const nextStep =
      request.cause === 'stall'
        ? 'Resume from the last verified browser state and continue with the next unfinished step.'
        : 'Use the verified progress below to continue from the next unfinished step and avoid repeating confirmed work.';
    const lines = [
      '[System fallback recovery]',
      diagnosis,
      'The failed attempt tool history has been removed; rely on this verified summary instead.',
    ];
    if (completedSteps.length > 0) {
      lines.push('', 'Completed steps:');
      for (const step of completedSteps) lines.push(`- ${step}`);
    }
    if (browserHints.length > 0) {
      lines.push('', 'Last known browser state:');
      for (const hint of browserHints) lines.push(`- ${hint}`);
    }
    if (request.latestBoundary) {
      lines.push('', `Latest verified boundary: ${request.latestBoundary.summary}`);
    }
    if (request.repetitionSignals.length > 0) {
      lines.push('', 'Repetition warnings:');
      for (const signal of request.repetitionSignals) lines.push(`- ${signal}`);
    }
    if (request.partialContent) {
      lines.push('', 'Partial assistant text from the failed attempt:', request.partialContent);
    }
    lines.push('', `Next step: ${nextStep}`);
    lines.push(
      'Only repeat a completed action if the current page state clearly contradicts this summary.',
    );
    lines.push('End your final answer by calling task_complete or task_blocked.');

    return {
      action: options?.action ?? 'retry',
      operatorMessage:
        request.cause === 'stall'
          ? SYSTEM_FALLBACK_STALL_PROMPT
          : SYSTEM_FALLBACK_COMPLETION_PROMPT,
      modelMessage: lines.join('\n'),
      diagnosis,
      nextStep,
      completedSteps,
    };
  }

  private buildRetryContextMessage(
    cause: RecoveryCause,
    attempt: number,
    modelMessage: string,
    source: RecoverySource,
  ): Message {
    return {
      id: `system:${cause}-retry:${attempt}`,
      role: 'system',
      content: modelMessage,
      timestamp: 0,
      metadata: {
        transient: true,
        source: cause === 'stall' ? 'watchdog-resume' : 'completion-resume',
        recoverySource: source,
      },
    };
  }

  private formatToolOutputPreview(output: string): string {
    return this.truncateResumeText(output, 180).replace(/\s+/g, ' ').trim();
  }

  private truncateResumeText(text: string, maxChars: number): string {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  private serializeDebugValue(
    value: unknown,
    maxChars: number,
  ): { value: string; truncated: boolean } {
    const raw =
      typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
    if (raw.length <= maxChars) {
      return { value: raw, truncated: false };
    }
    return {
      value: `${raw.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`,
      truncated: true,
    };
  }

  private buildToolDebugPayload(
    toolCall: ToolCall,
    result?: ToolResult,
    toolName?: string,
  ): Record<string, unknown> {
    const argsPreview = this.serializeDebugValue(toolCall.args, DEBUG_TOOL_STRUCTURED_MAX_CHARS);
    if (!result) {
      return {
        requestedToolName: toolCall.name,
        toolName: toolName ?? (toolCall.name.trim() || toolCall.name),
        toolCallId: toolCall.id,
        toolArgs: argsPreview.value,
        debugPayloadTruncated: argsPreview.truncated,
      };
    }

    const outputPreview = this.serializeDebugValue(result.output, DEBUG_TOOL_OUTPUT_MAX_CHARS);
    const detailsPreview = result.details
      ? this.serializeDebugValue(result.details, DEBUG_TOOL_STRUCTURED_MAX_CHARS)
      : null;
    const resumeMetadata =
      result.metadata && typeof result.metadata === 'object'
        ? (result.metadata.resume ?? null)
        : null;
    const resumePreview = resumeMetadata
      ? this.serializeDebugValue(resumeMetadata, DEBUG_TOOL_STRUCTURED_MAX_CHARS)
      : null;

    return {
      requestedToolName: toolCall.name,
      toolName: toolName ?? (toolCall.name.trim() || toolCall.name),
      toolCallId: toolCall.id,
      toolArgs: argsPreview.value,
      toolOutput: outputPreview.value,
      toolDetails: detailsPreview?.value ?? null,
      toolResume: resumePreview?.value ?? null,
      isError: result.isError,
      warnings: result.warnings ?? [],
      truncated: result.truncated ?? false,
      debugPayloadTruncated:
        argsPreview.truncated ||
        outputPreview.truncated ||
        Boolean(detailsPreview?.truncated) ||
        Boolean(resumePreview?.truncated),
    };
  }

  private recordCheckpoint(
    continuity: TurnContinuityState,
    step: string,
    status: TaskCheckpointStatus,
    evidence: string,
  ): TaskCheckpoint {
    const checkpoint: TaskCheckpoint = {
      step,
      status,
      evidence,
      summary: `${step} (${status}): ${this.truncateResumeText(evidence, 220)}`,
    };

    const existingIndex = continuity.taskCheckpoints.findIndex((entry) => entry.step === step);
    if (existingIndex >= 0) {
      continuity.taskCheckpoints[existingIndex] = checkpoint;
    } else {
      continuity.taskCheckpoints.push(checkpoint);
    }

    this.recordProgressEntry(continuity, {
      source: 'checkpoint',
      action: 'task_checkpoint',
      summary: checkpoint.summary,
      stateChanging: status === 'done',
      isError: false,
      checkpointStatus: status,
    });

    this.recordBoundary(continuity, {
      kind: 'checkpoint',
      action: 'task_checkpoint',
      summary: checkpoint.summary,
      stateChanging: status === 'done',
      evidence,
      checkpointStatus: status,
    });

    this.appendTurnJournalEntry('checkpoint', checkpoint.summary, {
      step,
      status,
      evidence,
    });

    return checkpoint;
  }

  private recordAttemptToolProgress(
    completionState: AttemptCompletionState,
    toolName: string,
    result: ToolResult,
  ): void {
    const continuity = completionState.continuity;
    const entry = this.createProgressEntry(toolName, result);
    if (!entry) return;
    this.recordProgressEntry(continuity, entry);
    this.updateBrowserState(continuity.browserState, result);
    if (entry.stateChanging && !entry.isError) {
      this.recordBoundary(continuity, {
        kind: 'tool',
        action: entry.action,
        summary: entry.summary,
        stateChanging: true,
        url: entry.url,
        tabId: entry.tabId,
      });
    }
  }

  private createProgressEntry(toolName: string, result: ToolResult): ProgressEntry | null {
    const resume = this.getBrowserResumeMetadata(result);
    if (resume?.summary) {
      return {
        source: 'tool',
        toolName,
        action: resume.action ?? toolName,
        summary: this.truncateResumeText(resume.summary, 220),
        url: resume.url,
        tabId: resume.tabId ?? resume.activeTabId,
        stateChanging: resume.stateChanging ?? this.isLikelyStateChangingTool(toolName),
        isError: result.isError,
      };
    }

    const outputPreview = this.formatToolOutputPreview(result.output);
    if (!outputPreview) return null;
    return {
      source: 'tool',
      toolName,
      action: toolName,
      summary: `${toolName}: ${outputPreview}`,
      stateChanging: this.isLikelyStateChangingTool(toolName),
      isError: result.isError,
    };
  }

  private recordProgressEntry(continuity: TurnContinuityState, entry: ProgressEntry): void {
    const last = continuity.progressLedger.at(-1);
    if (
      last &&
      entry.source === 'tool' &&
      last.source === 'tool' &&
      !entry.stateChanging &&
      !last.stateChanging &&
      last.action === entry.action &&
      last.summary === entry.summary &&
      last.url === entry.url &&
      last.tabId === entry.tabId
    ) {
      return;
    }

    continuity.progressLedger.push(entry);

    while (continuity.progressLedger.length > 50) {
      const removableIndex = continuity.progressLedger.findIndex(
        (candidate) => candidate.source === 'tool' && !candidate.stateChanging,
      );
      continuity.progressLedger.splice(removableIndex >= 0 ? removableIndex : 0, 1);
    }
  }

  private getBrowserResumeMetadata(result: ToolResult): BrowserResumeMetadata | null {
    const metadata = result.metadata;
    if (!metadata || typeof metadata !== 'object') return null;
    const resume = metadata.resume;
    if (!resume || typeof resume !== 'object') return null;
    return resume as BrowserResumeMetadata;
  }

  private updateBrowserState(browserState: BrowserStateSnapshot, result: ToolResult): void {
    const resume = this.getBrowserResumeMetadata(result);
    if (!resume) return;
    const stateDelta =
      resume.stateDelta && typeof resume.stateDelta === 'object'
        ? (resume.stateDelta as Record<string, unknown>)
        : null;
    const deltaUrl = typeof stateDelta?.currentUrl === 'string' ? stateDelta.currentUrl : undefined;
    const deltaActiveTabId =
      typeof stateDelta?.activeTabId === 'string' ? stateDelta.activeTabId : undefined;
    const deltaTabs = Array.isArray(stateDelta?.tabs)
      ? (stateDelta.tabs as BrowserTabSnapshot[])
      : undefined;

    if (resume.url ?? deltaUrl) {
      browserState.currentUrl = resume.url ?? deltaUrl;
    }
    if (resume.activeTabId ?? deltaActiveTabId) {
      browserState.activeTabId = resume.activeTabId ?? deltaActiveTabId;
    } else if (resume.tabId && resume.stateChanging) {
      browserState.activeTabId = resume.tabId;
    }
    const nextTabs = resume.tabs?.length ? resume.tabs : deltaTabs;
    if (nextTabs?.length) {
      browserState.tabs = nextTabs.map((tab) => ({ ...tab }));
      const active = nextTabs.find((tab) => tab.active);
      if (active) {
        browserState.activeTabId = active.id;
        browserState.currentUrl = active.url;
      }
    }
  }

  private cloneBrowserState(browserState: BrowserStateSnapshot): BrowserStateSnapshot {
    return {
      currentUrl: browserState.currentUrl,
      activeTabId: browserState.activeTabId,
      tabs: browserState.tabs?.map((tab) => ({ ...tab })),
    };
  }

  private isLikelyStateChangingTool(toolName: string): boolean {
    return !READ_ONLY_TOOL_NAMES.has(toolName);
  }

  private evaluateCompletionGuard(
    displayContent: string,
    finishMeta: StreamFinishMetadata | undefined,
    completionState: AttemptCompletionState,
  ): CompletionGuardFailure | null {
    const trimmedContent = displayContent.trim();
    const hadExternalToolActivity = completionState.externalToolCallCount > 0;
    const endedOnToolCalls =
      finishMeta?.finishReason === 'tool-calls' ||
      finishMeta?.stepFinishReasons.at(-1) === 'tool-calls';

    if (trimmedContent.length === 0 && hadExternalToolActivity) {
      return {
        message: 'Turn ended after tool activity without a final answer.',
        signal: completionState.signal,
      };
    }

    if (endedOnToolCalls) {
      return {
        message: 'Turn ended on tool-calls without a final answer.',
        signal: completionState.signal,
      };
    }

    if (hadExternalToolActivity && completionState.signal === 'none') {
      return {
        message: 'Tool-driven turn ended without task_complete or task_blocked.',
        signal: completionState.signal,
      };
    }

    return null;
  }

  private async awaitStreamAttempt(
    streamPromise: Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let abortTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        abortController.signal.removeEventListener('abort', onAbort);
        if (abortTimer) {
          clearTimeout(abortTimer);
          abortTimer = null;
        }
      };

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const settleReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onAbort = () => {
        this.logStreamDebug('provider_abort_observed', {
          phase: this.streamPhase,
          activeToolName: this.activeToolCall?.name,
          activeToolCallId: this.activeToolCall?.id,
        });

        if (abortTimer) return;
        abortTimer = setTimeout(() => {
          if (settled) return;
          const elapsedSeconds = Math.max(
            1,
            Math.round((Date.now() - this.lastStreamActivityAt) / 1000),
          );
          this.emitWatchdog(
            'teardown_timeout',
            `Provider did not settle within ${this.streamAbortGraceMs}ms after abort; continuing retry.`,
            { level: 'warn', elapsedSeconds },
          );
          settleReject(createAbortError('Stream aborted'));
        }, this.streamAbortGraceMs);
      };

      abortController.signal.addEventListener('abort', onAbort, { once: true });
      if (abortController.signal.aborted) {
        onAbort();
      }

      streamPromise.then(settleResolve, settleReject);
    });
  }

  private startStreamWatchdog(latestUserMessage?: string): void {
    this.stopStreamWatchdog();
    this.markStreamWaitingModel();
    this.streamDeferredUntil = 0;

    this.streamWatchdog = setInterval(() => {
      if (!this.currentAttemptCompletionState || !this.currentStreamTurn) return;
      if (this.streamDeferredUntil > Date.now()) return;
      const elapsed = Date.now() - this.lastStreamActivityAt;
      const stallThresholdMs = this.getCurrentStallThresholdMs();
      if (elapsed < stallThresholdMs) return;
      if (this.streamNudgeCount >= this.maxNudgeRetries) return;
      if (this._nudgeInFlight) return;

      const elapsedSeconds = Math.round(elapsed / 1000);
      const diagnostics = this.getStreamDiagnostics(elapsedSeconds);
      this.emitWatchdog(
        'stalled',
        `Stalled after ${elapsedSeconds}s while ${this.describeStreamLocation()}.`,
        { level: 'warn', elapsedSeconds },
      );
      this.emit({ type: 'cerebrum:stall', ...diagnostics });

      if (!this.cerebellum?.isConnected()) {
        this.emitWatchdog(
          'abort_issued',
          'Cerebellum disconnected during an active stream; aborting the turn.',
          { level: 'warn', elapsedSeconds },
        );
        this.abortController?.abort();
        return;
      }

      this._nudgeInFlight = true;

      void (async () => {
        try {
          const request = this.buildRecoveryRequest({
            cause: 'stall',
            attempt: this.currentStreamTurn!.attempt,
            partialContent: this.currentPartialContent,
            completionState: this.currentAttemptCompletionState!,
            turnOutcome: 'stalled',
            latestUserMessage,
            elapsedSeconds,
          });
          const { source, assessment } = await this.assessTurnRecovery(request);
          this.emitRecoveryTrace(
            'stall',
            source,
            assessment,
            assessment.action === 'stop' ? 'warn' : 'info',
          );
          this.appendTurnJournalEntry('recovery', assessment.operatorMessage, {
            cause: 'stall',
            source,
            action: assessment.action,
            diagnosis: assessment.diagnosis,
            nextStep: assessment.nextStep,
            waitSeconds: assessment.waitSeconds,
            completedSteps: assessment.completedSteps,
          });

          if (assessment.action === 'wait') {
            const waitSeconds = Math.max(
              15,
              assessment.waitSeconds ?? this.streamStallThreshold / 1000,
            );
            this.streamDeferredUntil = Date.now() + waitSeconds * 1000;
            return;
          }

          if (assessment.action === 'retry') {
            this.streamNudgeCount++;
            this.pendingRecoveryDecision = { cause: 'stall', source, assessment };
            this.recordBoundary(this.currentAttemptCompletionState!.continuity, {
              kind: 'recovery',
              action: 'stall_retry',
              summary: assessment.diagnosis,
              stateChanging: false,
            });
            this.emitWatchdog(
              'nudge_requested',
              `Cerebellum requested nudge ${this.streamNudgeCount}/${this.maxNudgeRetries} after ${elapsedSeconds}s while ${this.describeStreamLocation()}.`,
              { level: 'info', elapsedSeconds },
            );
            this.emit({
              type: 'cerebrum:stall:nudge',
              attempt: this.streamNudgeCount,
              ...diagnostics,
            });
            this.emitWatchdog(
              'abort_issued',
              `Aborting stalled stream attempt ${this.currentStreamTurn?.attempt ?? 0}.`,
              { level: 'warn', elapsedSeconds },
            );
            this.abortController?.abort();
            return;
          }

          this.pendingRecoveryDecision = { cause: 'stall', source, assessment };
          this.recordBoundary(this.currentAttemptCompletionState!.continuity, {
            kind: 'recovery',
            action: 'stall_stop',
            summary: assessment.diagnosis,
            stateChanging: false,
          });
          this.emitWatchdog(
            'abort_issued',
            'Aborting stalled stream because recovery guidance requested stop.',
            { level: 'warn', elapsedSeconds },
          );
          this.abortController?.abort();
        } catch {
          const request = this.buildRecoveryRequest({
            cause: 'stall',
            attempt: this.currentStreamTurn!.attempt,
            partialContent: this.currentPartialContent,
            completionState: this.currentAttemptCompletionState!,
            turnOutcome: 'stalled',
            latestUserMessage,
            elapsedSeconds,
          });
          const assessment = this.buildFallbackRecoveryAssessment(request, {
            reason: `Recovery assessment failed after ${elapsedSeconds}s while ${this.describeStreamLocation()}.`,
          });
          this.pendingRecoveryDecision = { cause: 'stall', source: 'fallback', assessment };
          this.emitRecoveryTrace('stall', 'fallback', assessment, 'warn');
          this.appendTurnJournalEntry('recovery', assessment.operatorMessage, {
            cause: 'stall',
            source: 'fallback',
            action: assessment.action,
            diagnosis: assessment.diagnosis,
            nextStep: assessment.nextStep,
            waitSeconds: assessment.waitSeconds,
            completedSteps: assessment.completedSteps,
          });
          this.streamNudgeCount++;
          this.recordBoundary(this.currentAttemptCompletionState!.continuity, {
            kind: 'recovery',
            action: 'stall_retry',
            summary: assessment.diagnosis,
            stateChanging: false,
          });
          this.emitWatchdog(
            'nudge_requested',
            `Fallback retry ${this.streamNudgeCount}/${this.maxNudgeRetries} after ${elapsedSeconds}s while ${this.describeStreamLocation()}.`,
            { level: 'info', elapsedSeconds },
          );
          this.emit({
            type: 'cerebrum:stall:nudge',
            attempt: this.streamNudgeCount,
            ...diagnostics,
          });
          this.emitWatchdog(
            'abort_issued',
            `Aborting stalled stream attempt ${this.currentStreamTurn?.attempt ?? 0}.`,
            { level: 'warn', elapsedSeconds },
          );
          this.abortController?.abort();
        } finally {
          this._nudgeInFlight = false;
        }
      })();
    }, 15_000);
  }
  private _nudgeInFlight = false;

  private stopStreamWatchdog(): void {
    if (this.streamWatchdog) {
      clearInterval(this.streamWatchdog);
      this.streamWatchdog = null;
    }
    this.resetStreamState();
  }

  async sendMessage(
    content: string,
    conversationId?: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    if (!this.cerebrum) throw new Error('Cerebrum not connected');
    if (this.cerebellum && !this.cerebellum.isConnected()) {
      throw new Error(
        'Cerebellum is offline. Fix the Cerebellum connection before continuing. Run: docker compose up -d cerebellum',
      );
    }

    const convId = conversationId ?? this.activeConversationId;
    if (!convId) throw new Error('No active conversation');

    if (content) {
      const userMessage = this.conversations.appendMessage(convId, 'user', content);
      this.emit({ type: 'message:user', message: userMessage });
    }
    const latestUserMessage =
      content ||
      [...this.conversations.getMessages(convId)]
        .reverse()
        .find((message) => message.role === 'user')?.content ||
      '';

    this.streamNudgeCount = 0;
    let completionRetryCount = 0;
    let nextRetryContext: Message | null = null;
    // Track message IDs from failed attempts so they can be excluded from retries and cleaned up.
    const failedAttemptMessageIds: string[] = [];
    const turnId = nanoid(10);
    const maxTotalAttempts = 1 + this.maxNudgeRetries + this.maxCompletionRetries;
    let loopTerminated = false;
    let nextRetryCause: RetryCause | null = null;
    const turnContinuity = this.createTurnContinuityState();

    try {
      for (let attempt = 0; attempt < maxTotalAttempts; attempt++) {
        const abortController = new AbortController();
        const attemptNumber = attempt + 1;
        const retryCause = nextRetryCause;
        nextRetryCause = null;
        const completionState = this.createAttemptCompletionState(turnContinuity);
        let completionGuardFailure: CompletionGuardFailure | null = null;
        const stallRetryCountAtStart = this.streamNudgeCount;
        const attemptMessageIds: string[] = [];
        const isCurrentAttempt = () => this.abortController === abortController;
        this.abortController = abortController;
        this.currentAttemptCompletionState = completionState;
        const sessionSource = options?.source ?? 'local';
        this.currentStreamTurn = {
          turnId,
          attempt: attemptNumber,
          conversationId: convId,
          sessionId: turnId,
          source: sessionSource,
        };
        const priorSession = this.currentQuerySession;
        this.currentQuerySession = this.createQuerySession(
          convId,
          turnId,
          attemptNumber,
          sessionSource,
          latestUserMessage,
          this.streamNudgeCount,
          completionRetryCount,
          priorSession,
        );
        this.saveCurrentQuerySession();
        if (attemptNumber === 1 && sessionSource === 'channel' && options?.ingress) {
          this.recordSessionEvent(
            convId,
            turnId,
            'channel_ingress',
            `Received channel message from ${options.ingress.senderName || options.ingress.senderId || 'unknown sender'}.`,
            {
              channelId: options.ingress.channelId,
              senderId: options.ingress.senderId,
              senderName: options.ingress.senderName,
              threadId: options.ingress.threadId,
              replyToId: options.ingress.replyToId,
              timestamp: options.ingress.timestamp,
            },
          );
        }
        this.currentPartialContent = '';
        this.currentLastContentKind = 'empty';
        this.currentJournaledContentLength = 0;
        this.pendingRecoveryDecision = null;
        log.info('stream_started', {
          turnId,
          attempt: attemptNumber,
          conversationId: convId,
          stallRetryCount: this.streamNudgeCount,
          completionRetryCount,
          retryCause,
        });
        this.appendTurnJournalEntry('turn_started', `Turn attempt ${attemptNumber} started.`, {
          retryCause: retryCause ?? null,
          latestUserMessage: this.truncateResumeText(latestUserMessage, 600),
          stallRetryCount: this.streamNudgeCount,
          completionRetryCount,
        });
        this.emit({
          type: 'message:cerebrum:start',
          conversationId: convId,
          turnId,
          sessionId: turnId,
          source: sessionSource,
        });
        this.startStreamWatchdog(latestUserMessage);

        let messages = this.conversations.getMessages(convId);

        // On retry: exclude failed attempts' messages from history.
        // The resume context already summarizes what happened — sending the raw tool calls
        // causes the model to repeat the exact same steps instead of continuing.
        if (failedAttemptMessageIds.length > 0) {
          const excludeSet = new Set(failedAttemptMessageIds);
          messages = messages.filter((m) => !excludeSet.has(m.id));
        }

        // Context window compaction
        if (
          this.compactionConfig.enabled &&
          this.cerebrum?.summarize &&
          shouldCompact(
            messages,
            this.compactionConfig.contextWindow,
            this.compactionConfig.threshold,
          )
        ) {
          try {
            const keepRecent = this.compactionConfig.keepRecentMessages;
            const olderMessages = messages.slice(0, Math.max(0, messages.length - keepRecent));
            if (olderMessages.length > 0) {
              log.info('Compacting conversation', {
                totalMessages: messages.length,
                compactingMessages: olderMessages.length,
                estimatedTokens: estimateMessageTokens(messages),
              });
              const summary = await this.cerebrum.summarize(olderMessages);
              messages = buildCompactionMessages(messages, summary, keepRecent);
            }
          } catch (error) {
            log.warn('Compaction failed, continuing with full context', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Build system prompt with runtime state + skills context
        const instance = this.instanceStore?.get();
        const allTools = this.getAllTools();
        const basePrompt = buildSystemPrompt({
          cerebellumConnected: this.cerebellum?.isConnected() ?? false,
          tools: allTools,
          autoMode: this.autoMode,
          gatewayMode: this.gatewayMode,
          connectedNodes: this.connectedNodes,
          gatewayUrl: this.gatewayUrl,
          profile: this.profile,
          finetuneStatus: {
            enabled: !!this.fineTuneDataProvider,
            status: this.fineTuneStatus.status,
            progress: this.fineTuneStatus.progress,
            lastJobId: this.fineTuneStatus.jobId || undefined,
          },
          recurringTasks: this.recurringTasks,
          instanceId: instance?.id,
          instanceCreatedAt: instance?.createdAt,
          finetuneCount: instance?.finetuneLineage.length,
          proactiveEnabled: this.proactiveEnabled,
          discoveryMode: this.discoveryMode,
        });
        const systemParts = [basePrompt];
        if (this.systemContext) systemParts.push(this.systemContext);
        const fullSystemPrompt = systemParts.join('\n\n---\n\n');

        const transientRetryMessages = nextRetryContext ? [nextRetryContext] : [];
        nextRetryContext = null;
        const allMessages: Message[] = [
          { id: 'system', role: 'system' as const, content: fullSystemPrompt, timestamp: 0 },
          ...transientRetryMessages,
          ...messages,
        ];

        const toolDefs = Object.fromEntries(allTools);
        let fullContent = '';
        let finalDisplayContent = '';
        let attemptFinishMeta: StreamFinishMetadata | undefined;
        const throwIfToolAttemptAborted = () => {
          if (!isCurrentAttempt()) {
            throw createAbortError('Tool execution aborted');
          }
          throwIfAborted(abortController.signal, 'Tool execution aborted');
        };

        try {
          const streamPromise = this.cerebrum.stream(
            allMessages,
            toolDefs,
            {
              onChunk: (chunk) => {
                if (!isCurrentAttempt() || abortController.signal.aborted) return;
                fullContent += chunk;
                this.currentPartialContent = fullContent;
                this.currentLastContentKind = 'text';
                this.markStreamWaitingModel();
                this.persistPartialContentSnapshot();
                this.emit({ type: 'message:cerebrum:chunk', chunk });
              },
              onToolCall: async (toolCall) => {
                throwIfToolAttemptAborted();
                this.logStreamDebug('tool_callback_started', this.buildToolDebugPayload(toolCall));

                this.markStreamWaitingTool(toolCall);
                this.currentLastContentKind = 'tool-call';
                const requestedToolName = toolCall.name;
                const normalizedToolName = requestedToolName.trim() || requestedToolName;
                this.appendTurnJournalEntry('tool_start', `Calling ${normalizedToolName}`, {
                  requestedToolName,
                  toolName: normalizedToolName,
                  callId: toolCall.id,
                  args: toolCall.args,
                });
                const isInternalTaskSignal = this.isInternalTaskSignalTool(normalizedToolName);
                if (isInternalTaskSignal) {
                  completionState.internalToolCallCount++;
                } else {
                  completionState.externalToolCallCount++;
                  this.emit({
                    type: 'message:cerebrum:toolcall',
                    toolCall: { ...toolCall, name: normalizedToolName },
                  });
                  this.emit({
                    type: 'tool:start',
                    callId: toolCall.id,
                    name: normalizedToolName,
                    requestedName:
                      requestedToolName !== normalizedToolName ? requestedToolName : undefined,
                    args: toolCall.args,
                  });
                }

                const { toolName, result } = await this.toolRuntime.execute({
                  toolCall,
                  tools: allTools,
                  conversationId: convId,
                  sessionKey: turnId,
                  scopeKey: convId,
                  turnId,
                  attempt: attemptNumber,
                  abortSignal: abortController.signal,
                });
                this.logStreamDebug(
                  'tool_callback_finished',
                  this.buildToolDebugPayload(toolCall, result, toolName),
                );

                throwIfAborted(abortController.signal, 'Tool execution aborted');

                this.markStreamWaitingModel();
                this.currentLastContentKind = result.isError ? 'error' : 'tool-call';
                if (!isInternalTaskSignal) {
                  this.emit({
                    type: 'tool:end',
                    callId: toolCall.id,
                    name: toolName,
                    requestedName: requestedToolName !== toolName ? requestedToolName : undefined,
                    args: toolCall.args,
                    result,
                  });
                }

                if (!isInternalTaskSignal && !result.isError) {
                  completionState.successfulExternalToolCount++;
                }

                // Cerebellum verification (non-blocking)
                if (
                  !isInternalTaskSignal &&
                  this.cerebellum?.isConnected() &&
                  this.verificationEnabled
                ) {
                  try {
                    throwIfAborted(abortController.signal, 'Tool execution aborted');

                    this.emit({ type: 'verification:start', callId: toolCall.id, toolName });

                    const toolArgs: Record<string, string> = {};
                    for (const [k, v] of Object.entries(toolCall.args)) {
                      toolArgs[k] = String(v);
                    }

                    const verifyPromise = this.cerebellum.verifyToolResult(
                      toolName,
                      toolArgs,
                      result.output,
                      !result.isError,
                    );

                    const timeoutPromise = new Promise<null>((resolve) =>
                      setTimeout(() => resolve(null), this.verificationTimeoutMs),
                    );

                    const verification = await Promise.race([verifyPromise, timeoutPromise]);

                    throwIfAborted(abortController.signal, 'Tool execution aborted');

                    if (verification && !verification.passed) {
                      const failedChecks = verification.checks
                        .filter((c) => !c.passed)
                        .map((c) => c.description)
                        .join(', ');
                      result.output += `\n[Cerebellum warning: ${failedChecks}]`;
                    }

                    if (verification) {
                      result.metadata = {
                        ...(result.metadata ?? {}),
                        verification: {
                          passed: verification.passed,
                          modelVerdict: verification.modelVerdict,
                          failedChecks: verification.checks
                            .filter((check) => !check.passed)
                            .map((check) => check.description),
                        },
                      };
                      const vResult: VerificationResult = {
                        passed: verification.passed,
                        checks: verification.checks,
                        modelVerdict: verification.modelVerdict,
                        toolCallId: toolCall.id,
                        toolName,
                      };
                      this.emit({
                        type: 'verification:end',
                        result: vResult,
                        conversationId: convId,
                        sessionId: turnId,
                      });
                    }
                  } catch {
                    // Verification failure should never block tool execution
                  }
                }

                throwIfToolAttemptAborted();

                const toolJournalEntry = this.createProgressEntry(toolName, result);
                this.appendTurnJournalEntry(
                  'tool_end',
                  toolJournalEntry?.summary ??
                    `${toolName}: ${this.formatToolOutputPreview(result.output)}`,
                  {
                    requestedToolName,
                    toolName,
                    callId: toolCall.id,
                    isError: result.isError,
                    args: toolCall.args,
                    output: this.truncateResumeText(result.output, 2_000),
                    details: result.details,
                    metadata: result.metadata,
                  },
                );

                if (!isInternalTaskSignal) {
                  this.recordAttemptToolProgress(completionState, toolName, result);
                  const toolMsg = this.conversations.appendMessage(convId, 'tool', result.output, {
                    toolResult: result,
                    metadata: {
                      toolName,
                      ...(requestedToolName !== toolName ? { requestedToolName } : {}),
                    },
                  });
                  attemptMessageIds.push(toolMsg.id);
                }

                return result;
              },
              onFinish: (content, toolCalls, finishMeta) => {
                if (!isCurrentAttempt() || abortController.signal.aborted) return;
                this.stopStreamWatchdog();
                let displayContent = content;
                finalDisplayContent = content;
                attemptFinishMeta = finishMeta;
                this.currentLastContentKind =
                  finishMeta?.lastContentKind ??
                  (content.trim() ? 'text' : this.currentLastContentKind);
                this.persistPartialContentSnapshot(true);
                const visibleToolCalls = toolCalls?.filter(
                  (toolCall) => !this.isInternalTaskSignalTool(toolCall.name),
                );
                const turnOutcome = this.classifyTurnOutcome(
                  displayContent,
                  finishMeta,
                  completionState,
                );

                log.info('stream_finish_observed', {
                  turnId,
                  attempt: attemptNumber,
                  conversationId: convId,
                  finishReason: finishMeta?.finishReason,
                  rawFinishReason: finishMeta?.rawFinishReason,
                  lastContentKind: finishMeta?.lastContentKind,
                  stepCount: finishMeta?.stepCount ?? 0,
                  chunkCount: finishMeta?.chunkCount ?? 0,
                  toolCallCount: finishMeta?.toolCallCount ?? 0,
                  textChars: finishMeta?.textChars ?? content.length,
                  completionSignal: completionState.signal,
                  turnOutcome,
                });

                // Check for discovery completion — parse and strip the tag before storing
                if (this.discoveryMode && content.includes('<discovery_complete>')) {
                  const parsed = this.parseDiscoveryCompletion(content);
                  // Strip the tag block from the displayed/stored content
                  displayContent = content
                    .replace(/<discovery_complete>[\s\S]*?<\/discovery_complete>/g, '')
                    .trim();
                  finalDisplayContent = displayContent;
                  if (parsed && this.onDiscoveryComplete) {
                    this.discoveryMode = false;
                    this.onDiscoveryComplete(parsed);
                    log.info('Discovery completed', { name: parsed.name });
                  }
                }

                this.appendTurnJournalEntry('turn_finished', `Turn ended with ${turnOutcome}.`, {
                  finishReason: finishMeta?.finishReason,
                  rawFinishReason: finishMeta?.rawFinishReason,
                  lastContentKind: finishMeta?.lastContentKind ?? this.currentLastContentKind,
                  turnOutcome,
                  textChars: finishMeta?.textChars ?? displayContent.length,
                  toolCallCount: finishMeta?.toolCallCount ?? 0,
                  completionSignal: completionState.signal,
                  finalContent: this.truncateResumeText(displayContent, 2_000),
                });
                this.pruneTurnJournals(convId);

                const guardFailure = this.evaluateCompletionGuard(
                  displayContent,
                  finishMeta,
                  completionState,
                );
                if (guardFailure) {
                  completionGuardFailure = guardFailure;
                  finalDisplayContent = displayContent;
                  this.emitCompletionTrace(
                    'guard_triggered',
                    guardFailure.message,
                    guardFailure.signal,
                    'warn',
                  );
                  log.warn('completion_guard_triggered', {
                    turnId,
                    attempt: attemptNumber,
                    conversationId: convId,
                    finishReason: finishMeta?.finishReason,
                    rawFinishReason: finishMeta?.rawFinishReason,
                    lastContentKind: finishMeta?.lastContentKind,
                    stepCount: finishMeta?.stepCount ?? 0,
                    chunkCount: finishMeta?.chunkCount ?? 0,
                    toolCallCount: finishMeta?.toolCallCount ?? 0,
                    textChars: finishMeta?.textChars ?? displayContent.length,
                    completionSignal: completionState.signal,
                    turnOutcome,
                  });
                  return;
                }

                // Clean up failed attempt messages from conversation store
                // so they don't leak into future turns (preserves successful attempt's tool results)
                if (failedAttemptMessageIds.length > 0) {
                  const deleted = this.conversations.deleteMessages(
                    convId,
                    failedAttemptMessageIds,
                  );
                  if (deleted > 0) {
                    log.info('Cleaned up failed attempt messages', {
                      deleted,
                      convId,
                      attempt: attemptNumber,
                    });
                  }
                }

                const cerebrumMessage = this.conversations.appendMessage(
                  convId,
                  'cerebrum',
                  displayContent,
                  visibleToolCalls?.length ? { toolCalls: visibleToolCalls } : undefined,
                );
                this.emit({
                  type: 'message:cerebrum:end',
                  conversationId: convId,
                  turnId,
                  sessionId: turnId,
                  source: sessionSource,
                  message: cerebrumMessage,
                });
                log.info('stream_finished', {
                  turnId,
                  attempt: attemptNumber,
                  conversationId: convId,
                  stallRetryCount: this.streamNudgeCount,
                  completionRetryCount,
                  retryCause,
                });
                if (retryCause === 'completion') {
                  this.emitCompletionTrace(
                    'retry_recovered',
                    `Completion retry ${completionRetryCount}/${this.maxCompletionRetries} recovered on attempt ${attemptNumber}.`,
                    completionState.signal,
                    'info',
                  );
                } else if (retryCause === 'stall') {
                  this.emitWatchdog(
                    'retry_recovered',
                    `Stall retry ${this.streamNudgeCount}/${this.maxNudgeRetries} recovered on attempt ${attemptNumber}.`,
                    { level: 'info' },
                  );
                }
              },
              onError: (error) => {
                if (!isCurrentAttempt()) return;
                this.stopStreamWatchdog();
                // Don't log/emit if the abort was intentional (nudge or Cerebellum disconnect) — catch block handles it
                if (abortController.signal.aborted) return;
                log.error('Cerebrum stream error', { error: error.message });
                this.emit({ type: 'error', error });
              },
            },
            { abortSignal: abortController.signal },
          );
          await this.awaitStreamAttempt(streamPromise, abortController);

          const completionFailure = completionGuardFailure as CompletionGuardFailure | null;
          if (completionFailure !== null) {
            const turnOutcome = this.classifyTurnOutcome(
              finalDisplayContent,
              attemptFinishMeta,
              completionState,
            );
            const completionSignal = completionFailure.signal;
            const recoveryRequest = this.buildRecoveryRequest({
              cause: 'completion',
              attempt: attemptNumber,
              partialContent: fullContent || finalDisplayContent,
              completionState,
              turnOutcome,
              latestUserMessage,
              completionRetryCount,
              finishMeta: attemptFinishMeta,
            });
            const { source, assessment } = await this.assessTurnRecovery(recoveryRequest);
            this.emitRecoveryTrace(
              'completion',
              source,
              assessment,
              assessment.action === 'stop' ? 'warn' : 'info',
            );
            nextRetryContext = this.buildRetryContextMessage(
              'completion',
              attemptNumber,
              assessment.modelMessage,
              source,
            );
            this.appendTurnJournalEntry('recovery', assessment.operatorMessage, {
              cause: 'completion',
              source,
              action: assessment.action,
              diagnosis: assessment.diagnosis,
              nextStep: assessment.nextStep,
              completedSteps: assessment.completedSteps,
              turnOutcome,
              finishReason: attemptFinishMeta?.finishReason,
            });
            this.recordBoundary(completionState.continuity, {
              kind: 'recovery',
              action: assessment.action === 'stop' ? 'completion_stop' : 'completion_retry',
              summary: assessment.diagnosis,
              stateChanging: false,
            });
            log.info('completion_retry_context_prepared', {
              turnId,
              attempt: attemptNumber,
              conversationId: convId,
              source,
              action: assessment.action,
              finishReason: attemptFinishMeta?.finishReason,
              rawFinishReason: attemptFinishMeta?.rawFinishReason,
              hasPartialContent: (fullContent || finalDisplayContent).trim().length > 0,
              progressEntries: completionState.continuity.progressLedger.length,
              taskCheckpoints: completionState.continuity.taskCheckpoints.length,
              completedSteps: assessment.completedSteps,
              nextStep: assessment.nextStep,
              turnOutcome,
              lastContentKind: attemptFinishMeta?.lastContentKind,
              latestBoundary: completionState.continuity.boundaries.at(-1),
              repetitionSignals: recoveryRequest.repetitionSignals,
            });

            if (assessment.action === 'stop') {
              failedAttemptMessageIds.push(...attemptMessageIds);
              const diagnosticMessage = this.conversations.appendMessage(
                convId,
                'system',
                assessment.operatorMessage,
              );
              this.emit({ type: 'message:system', message: diagnosticMessage });
              this.emitCompletionTrace(
                'retry_failed',
                assessment.diagnosis,
                completionSignal,
                'error',
              );
              this.appendTurnJournalEntry('turn_error', assessment.diagnosis || 'Recovery returned stop.', {
                retryCause: 'completion',
                completionRetryCount,
                stallRetryCount: this.streamNudgeCount,
                error: assessment.diagnosis || 'Recovery returned stop.',
              });
              this.emit({
                type: 'error',
                error: new Error(
                  assessment.diagnosis ||
                    'Turn ended without a valid completion signal or final answer.',
                ),
              });
              if (failedAttemptMessageIds.length > 0) {
                this.conversations.deleteMessages(convId, failedAttemptMessageIds);
              }
              loopTerminated = true;
              break;
            }

            if (completionRetryCount < this.maxCompletionRetries) {
              completionRetryCount++;
              const systemMessage = this.conversations.appendMessage(
                convId,
                'system',
                assessment.operatorMessage,
              );
              attemptMessageIds.push(systemMessage.id);
              failedAttemptMessageIds.push(...attemptMessageIds);
              this.emit({ type: 'message:system', message: systemMessage });
              this.emitCompletionTrace(
                'retry_started',
                `Retrying attempt ${attemptNumber + 1} after incomplete completion (${completionRetryCount}/${this.maxCompletionRetries}).`,
                completionSignal,
                'info',
              );
              nextRetryCause = 'completion';
              continue;
            }

            failedAttemptMessageIds.push(...attemptMessageIds);
            const diagnosticMessage = this.conversations.appendMessage(
              convId,
              'system',
              source === 'cerebellum'
                ? '[Cerebellum] The turn ended repeatedly without a valid completion signal or final answer.'
                : '[System fallback] The turn ended repeatedly without a valid completion signal or final answer.',
            );
            this.emit({ type: 'message:system', message: diagnosticMessage });
            this.emitCompletionTrace(
              'retry_failed',
              `Completion retries exhausted after ${completionRetryCount}/${this.maxCompletionRetries}: ${assessment.diagnosis || completionFailure.message}`,
              completionSignal,
              'error',
            );
            this.appendTurnJournalEntry('turn_error', `Completion retries exhausted (${completionRetryCount}/${this.maxCompletionRetries}).`, {
              retryCause: 'completion',
              completionRetryCount,
              stallRetryCount: this.streamNudgeCount,
              error: assessment.diagnosis || 'Completion retries exhausted.',
            });
            this.emit({
              type: 'error',
              error: new Error(
                assessment.diagnosis ||
                  'Turn ended without a valid completion signal or final answer.',
              ),
            });
            // Clean up all failed attempt messages on exhaustion
            if (failedAttemptMessageIds.length > 0) {
              this.conversations.deleteMessages(convId, failedAttemptMessageIds);
            }
            loopTerminated = true;
            break;
          }
          loopTerminated = true;
          break; // success — exit retry loop
        } catch (error) {
          const failureState = this.getStreamState();
          this.stopStreamWatchdog();
          failedAttemptMessageIds.push(...attemptMessageIds);
          const recoveryDecision = this.pendingRecoveryDecision;
          this.pendingRecoveryDecision = null;
          const stallRecovery = recoveryDecision as {
            cause: 'stall';
            source: RecoverySource;
            assessment: TurnRecoveryAssessment;
          } | null;

          const isRecoveryRetryAbort =
            abortController.signal.aborted &&
            stallRecovery !== null &&
            stallRecovery.assessment.action === 'retry' &&
            this.streamNudgeCount > stallRetryCountAtStart &&
            this.streamNudgeCount <= this.maxNudgeRetries;

          if (isRecoveryRetryAbort && stallRecovery) {
            nextRetryContext = this.buildRetryContextMessage(
              'stall',
              attemptNumber,
              stallRecovery.assessment.modelMessage,
              stallRecovery.source,
            );
            const systemMessage = this.conversations.appendMessage(
              convId,
              'system',
              stallRecovery.assessment.operatorMessage,
            );
            attemptMessageIds.push(systemMessage.id);
            failedAttemptMessageIds.push(...attemptMessageIds);
            this.emit({ type: 'message:system', message: systemMessage });
            this.emitWatchdog(
              'retry_started',
              `Retrying stalled turn with attempt ${attemptNumber + 1} (stall retry ${this.streamNudgeCount}/${this.maxNudgeRetries}).`,
              { level: 'info' },
            );
            nextRetryCause = 'stall';
            continue; // retry loop
          }

          if (
            abortController.signal.aborted &&
            stallRecovery !== null &&
            stallRecovery.assessment.action === 'stop'
          ) {
            const systemMessage = this.conversations.appendMessage(
              convId,
              'system',
              stallRecovery.assessment.operatorMessage,
            );
            this.emit({ type: 'message:system', message: systemMessage });
            this.appendTurnJournalEntry('turn_error', stallRecovery.assessment.diagnosis || 'Stall recovery returned stop.', {
              retryCause: 'stall',
              stallRetryCount: this.streamNudgeCount,
              completionRetryCount,
              error: stallRecovery.assessment.diagnosis || 'Stall recovery returned stop.',
            });
            this.emit({ type: 'error', error: new Error(stallRecovery.assessment.diagnosis) });
            if (failedAttemptMessageIds.length > 0) {
              this.conversations.deleteMessages(convId, failedAttemptMessageIds);
            }
            loopTerminated = true;
            break;
          }

          // Check if Cerebellum dropped mid-stream
          if (this.cerebellum && !this.cerebellum.isConnected() && abortController.signal.aborted) {
            const err = new Error(
              'Cerebellum disconnected during active response. Restart it with: docker compose up -d cerebellum',
            );
            log.error('Cerebellum disconnected mid-stream', { error: err.message });
            this.appendTurnJournalEntry('turn_error', err.message, {
              retryCause,
              stallRetryCount: this.streamNudgeCount,
              completionRetryCount,
              error: err.message,
              aborted: true,
            });
            this.emit({ type: 'error', error: err });
            if (failedAttemptMessageIds.length > 0) {
              this.conversations.deleteMessages(convId, failedAttemptMessageIds);
            }
            loopTerminated = true;
            break;
          }

          const err = error instanceof Error ? error : new Error(String(error));
          this.appendTurnJournalEntry(
            'turn_error',
            `Turn attempt ${attemptNumber} failed: ${err.message}`,
            {
              retryCause,
              stallRetryCount: this.streamNudgeCount,
              completionRetryCount,
              phase: failureState.phase,
              activeToolName: failureState.activeToolName,
              activeToolCallId: failureState.activeToolCallId,
              error: err.message,
            },
          );
          this.pruneTurnJournals(convId);
          if (retryCause === 'completion') {
            this.emitCompletionTrace(
              'retry_failed',
              `Completion retry attempt ${attemptNumber} failed: ${err.message}`,
              completionState.signal,
              'error',
            );
          } else if (retryCause === 'stall') {
            this.emitWatchdog(
              'retry_failed',
              `Stall retry attempt ${attemptNumber} failed: ${err.message}`,
              { level: 'error' },
            );
          }
          log.error('Send message failed', {
            error: err.message,
            turnId,
            attempt: attemptNumber,
            conversationId: convId,
            phase: failureState.phase,
            activeToolName: failureState.activeToolName,
            activeToolCallId: failureState.activeToolCallId,
            activeToolStartedAt: failureState.activeToolStartedAt,
            stallRetryCount: this.streamNudgeCount,
            completionRetryCount,
            retryCause,
          });
          this.emit({ type: 'error', error: err });
          // Clean up all failed attempt messages on error
          if (failedAttemptMessageIds.length > 0) {
            this.conversations.deleteMessages(convId, failedAttemptMessageIds);
          }
          loopTerminated = true;
          break;
        } finally {
          this.currentAttemptCompletionState = null;
        }
      }

      if (!loopTerminated) {
        const err = new Error(`Retry safety limit reached after ${maxTotalAttempts} attempts.`);
        log.error('Send message failed', {
          error: err.message,
          turnId,
          conversationId: convId,
          stallRetryCount: this.streamNudgeCount,
          completionRetryCount,
        });
        this.emit({ type: 'error', error: err });
      }
    } finally {
      this.currentQuerySession = null;
      this.currentStreamTurn = null;
    }
  }

  async start(): Promise<void> {
    if (!this.activeConversationId) {
      // Resume the most recent conversation, or create a new one
      const convs = this.conversations.list();
      if (convs.length > 0) {
        this.resumeConversation(convs[0].id);
        log.info('Auto-resumed last conversation', { id: convs[0].id });
      } else {
        this.startConversation();
      }
    }

    // Start sub-agent monitoring loop if cerebellum + sub-agents are enabled
    if (this.subAgentManager && this.cerebellum?.reportAgentStates) {
      this.startMonitorLoop();
    }

    // Recover interrupted sub-agents from disk
    if (this.subAgentManager) {
      const recovered = await this.subAgentManager.recoverFromDisk();
      for (const agentId of recovered) {
        const agent = this.subAgentManager.getAgent(agentId);
        if (agent) {
          this.emit({ type: 'agent:recovered', agentId, task: agent.task });
        }
      }
      if (recovered.length > 0) {
        log.info(`Recovered ${recovered.length} interrupted sub-agent(s)`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.stopFineTunePoller();
    this.removeAllListeners();
    log.info('Orchestrator stopped');
  }

  private startMonitorLoop(): void {
    if (this.monitorTimer) return;

    this.monitorTimer = setInterval(async () => {
      if (!this.subAgentManager || !this.cerebellum?.reportAgentStates) return;

      const agents = this.subAgentManager.listAgents();
      const activeAgents = agents.filter((a) => a.status === 'running' || a.status === 'pending');
      if (activeAgents.length === 0) return;

      try {
        const actions = await this.cerebellum.reportAgentStates(
          activeAgents.map((a) => ({
            id: a.id,
            task: a.task,
            status: a.status,
            spawnedAt: a.spawnedAt,
            lastActivityAt: a.lastActivityAt,
            timeoutMs: a.timeoutMs,
            messagesCount: a.messagesCount,
            toolCallsCount: a.toolCallsCount,
            retryCount: a.retryCount,
            progressNote: a.progressNote ?? '',
            progressPercent: a.progressPercent ?? -1,
            lastProgressAt: a.lastProgressAt ?? 0,
            deadlineAt: a.deadlineAt,
          })),
        );

        const actionable = actions.filter((a) => a.action !== 'ok');
        if (actionable.length > 0) {
          this.emit({ type: 'agent:health', actions: actionable });
        }

        for (const action of actions) {
          switch (action.action) {
            case 'ping':
              this.subAgentManager.ping(action.agentId);
              break;
            case 'retry':
              await this.subAgentManager.retry(action.agentId);
              break;
            case 'cancel':
              this.subAgentManager.cancel(action.agentId);
              break;
            case 'timeout':
              this.subAgentManager.timeout(action.agentId);
              break;
          }
        }
      } catch {
        // Monitor failure is non-blocking
      }

      // Prune old completed agents
      this.subAgentManager.prune();
    }, this.monitorIntervalMs);
  }
}
