import { nanoid } from 'nanoid';
import { TypedEventEmitter, type WatchdogStage } from './events.js';
import { ConversationStore } from './conversation.js';
import { SubAgentManager } from './sub-agent-manager.js';
import { createSubAgentTools } from './sub-agent-tools.js';
import { createLogger } from './logger.js';
import { buildSystemPrompt } from './system-prompt.js';
import type {
  Message,
  ToolCall,
  ToolResult,
  VerificationResult,
  AgentHealthAction,
  StreamPhase,
  StreamFinishMetadata,
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
const INTERNAL_TASK_SIGNAL_TOOL_NAMES = new Set([TASK_COMPLETE_TOOL, TASK_BLOCKED_TOOL]);
const COMPLETION_RETRY_PROMPT =
  '[Cerebellum] Your last turn ended without a final answer. Continue from where you left off and end by calling task_complete or task_blocked before your final answer.';

type CompletionSignal = 'none' | 'complete' | 'blocked';

interface AttemptCompletionState {
  signal: CompletionSignal;
  evidence: string;
  summary?: string;
  blocker?: string;
  successfulExternalToolCount: number;
  externalToolCallCount: number;
  internalToolCallCount: number;
  recentExternalToolSummaries: Array<{ toolName: string; outputPreview: string; isError: boolean }>;
}

interface CompletionGuardFailure {
  message: string;
  signal: CompletionSignal;
}

interface StallRetrySnapshot {
  attempt: number;
  phase: StreamPhase;
  activeToolName?: string;
  activeToolCallId?: string;
  partialContent?: string;
  recentExternalToolSummaries: Array<{ toolName: string; outputPreview: string; isError: boolean }>;
}

interface CompletionRetrySnapshot {
  attempt: number;
  finishReason?: string;
  partialContent?: string;
  recentExternalToolSummaries: Array<{ toolName: string; outputPreview: string; isError: boolean }>;
}

type RetryCause = 'stall' | 'completion';

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
  startFineTune?(config?: { method?: string }): Promise<{ jobId: string; started: boolean; error: string }>;
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
    status: 'idle', jobId: '', progress: 0, currentStep: 0,
    totalSteps: 0, currentLoss: 0, error: '', checkpointPath: '',
    startedAt: 0, completedAt: 0,
  };
  private _fineTuneHistory: Array<{ jobId: string; status: string; completedAt: number; loss: number }> = [];
  private gatewayMode: 'standalone' | 'gateway' | 'node' = 'standalone';
  private connectedNodes = 0;
  private gatewayUrl: string | undefined;
  private profile: { name: string; role: string; traits: string[] } | undefined;
  private instanceStore: InstanceStore | null = null;
  private proactiveEnabled = false;
  private discoveryMode = false;
  private onDiscoveryComplete: ((result: { name: string; role: string; traits: string[] }) => void) | null = null;
  private lastStreamActivityAt = 0;
  private streamWatchdog: ReturnType<typeof setInterval> | null = null;
  private streamNudgeCount = 0;
  private streamStallThreshold = 30_000;
  private maxNudgeRetries = 2;
  private maxCompletionRetries = 2;
  private streamPhase: StreamPhase = 'idle';
  private activeToolCall: { id: string; name: string; startedAt: number } | null = null;
  private currentStreamTurn: { turnId: string; attempt: number; conversationId: string } | null = null;
  private currentAttemptCompletionState: AttemptCompletionState | null = null;
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
    if (options?.streamStallThreshold) this.streamStallThreshold = options.streamStallThreshold * 1000;
    if (options?.maxNudgeRetries) {
      this.maxNudgeRetries = options.maxNudgeRetries;
      this.maxCompletionRetries = options.maxNudgeRetries;
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
      description: 'Record that a tool-driven task is complete. Call this once right before your final answer with a concise summary and concrete evidence.',
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
      description: 'Record that you are blocked and cannot finish the task. Call this once right before your final answer with the blocker and evidence.',
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
  }

  private getAllTools(): Map<string, ToolDefinition> {
    return new Map([...this.tools, ...this.internalTools]);
  }

  private isInternalTaskSignalTool(name: string): boolean {
    return INTERNAL_TASK_SIGNAL_TOOL_NAMES.has(name.trim() || name);
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
      if (state.successfulExternalToolCount === 0) {
        return {
          output: 'task_complete requires at least one successful external tool result in this attempt.',
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

  setDiscoveryCompleteHandler(handler: (result: { name: string; role: string; traits: string[] }) => void): void {
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

  getFineTuneHistory(): Array<{ jobId: string; status: string; completedAt: number; loss: number }> {
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

    this.fineTuneStatus = { ...this.fineTuneStatus, status: 'running', jobId: result.jobId, startedAt: Date.now() };
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
          log.info('Fine-tuning completed', { jobId: status.jobId, checkpoint: status.checkpointPath });
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

  private parseDiscoveryCompletion(text: string): { name: string; role: string; traits: string[] } | null {
    const match = text.match(/<discovery_complete>\s*([\s\S]*?)\s*<\/discovery_complete>/);
    if (!match) return null;
    const block = match[1];
    const nameMatch = block.match(/name:\s*(.+)/i);
    const roleMatch = block.match(/role:\s*(.+)/i);
    const traitsMatch = block.match(/traits:\s*(.+)/i);
    return {
      name: nameMatch?.[1]?.trim() || 'Cere',
      role: roleMatch?.[1]?.trim() || 'general-purpose assistant',
      traits: traitsMatch?.[1]?.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) ?? [],
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
          setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs / 1000}s`)), timeoutMs),
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
      stallDetected: this.streamWatchdog !== null && (Date.now() - this.lastStreamActivityAt) > stallThresholdMs,
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
      this.streamPhase !== 'waiting_tool'
      || this.activeToolCall?.id !== toolCall.id
      || this.activeToolCall?.name !== normalizedToolName;
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

  private describeStreamLocation(phase = this.streamPhase, activeToolName = this.activeToolCall?.name): string {
    if (phase === 'waiting_tool') {
      return activeToolName
        ? `waiting_tool/${activeToolName}`
        : 'waiting_tool';
    }
    return phase;
  }

  private getCurrentStallThresholdMs(phase = this.streamPhase, nudgeCount = this.streamNudgeCount): number {
    const phaseBase = phase === 'waiting_model'
      ? this.streamStallThreshold * 3
      : this.streamStallThreshold;
    return phaseBase + (nudgeCount * this.streamStallThreshold);
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
    stage: 'signal_recorded' | 'guard_triggered' | 'retry_started' | 'retry_recovered' | 'retry_failed',
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

  private createAttemptCompletionState(): AttemptCompletionState {
    return {
      signal: 'none',
      evidence: '',
      successfulExternalToolCount: 0,
      externalToolCallCount: 0,
      internalToolCallCount: 0,
      recentExternalToolSummaries: [],
    };
  }

  private buildStallRetrySnapshot(params: {
    attempt: number;
    phase: StreamPhase;
    activeToolName?: string;
    activeToolCallId?: string;
    partialContent: string;
    completionState: AttemptCompletionState;
  }): StallRetrySnapshot | null {
    const partialContent = this.truncateResumeText(params.partialContent, 600);
    const recentExternalToolSummaries = params.completionState.recentExternalToolSummaries.slice(-4);
    if (!partialContent && recentExternalToolSummaries.length === 0 && !params.activeToolName) {
      return null;
    }

    return {
      attempt: params.attempt,
      phase: params.phase,
      activeToolName: params.activeToolName,
      activeToolCallId: params.activeToolCallId,
      partialContent: partialContent || undefined,
      recentExternalToolSummaries,
    };
  }

  private buildStallRetryContextMessage(snapshot: StallRetrySnapshot | null): Message | null {
    if (!snapshot) return null;

    const lines = [
      '[Watchdog resume context]',
      `The previous attempt (${snapshot.attempt}) was interrupted after stalling while ${this.describeStreamLocation(snapshot.phase, snapshot.activeToolName)}.`,
      'Resume from the most advanced confirmed state below. Do not restart already completed actions unless the current page state contradicts them.',
    ];

    if (snapshot.recentExternalToolSummaries.length > 0) {
      lines.push('', 'Confirmed external tool results from the interrupted attempt:');
      for (const summary of snapshot.recentExternalToolSummaries) {
        const prefix = summary.isError ? '[error]' : '[ok]';
        lines.push(`- ${summary.toolName}: ${prefix} ${summary.outputPreview}`);
      }
    }

    if (snapshot.activeToolName) {
      lines.push(
        '',
        `The attempt was last waiting on: ${snapshot.activeToolName}${snapshot.activeToolCallId ? ` (${snapshot.activeToolCallId})` : ''}.`,
      );
    }

    if (snapshot.partialContent) {
      lines.push(
        '',
        'Partial assistant text emitted before interruption:',
        snapshot.partialContent,
      );
    }

    return {
      id: `system:stall-retry:${snapshot.attempt}`,
      role: 'system',
      content: lines.join('\n'),
      timestamp: 0,
      metadata: {
        transient: true,
        source: 'watchdog-resume',
      },
    };
  }

  private buildCompletionRetrySnapshot(params: {
    attempt: number;
    partialContent: string;
    completionState: AttemptCompletionState;
    finishMeta?: StreamFinishMetadata;
  }): CompletionRetrySnapshot | null {
    const partialContent = this.truncateResumeText(params.partialContent, 600);
    const recentExternalToolSummaries = params.completionState.recentExternalToolSummaries.slice(-4);
    const finishReason = params.finishMeta?.finishReason ?? params.finishMeta?.stepFinishReasons.at(-1);
    if (!partialContent && recentExternalToolSummaries.length === 0 && !finishReason) {
      return null;
    }

    return {
      attempt: params.attempt,
      finishReason,
      partialContent: partialContent || undefined,
      recentExternalToolSummaries,
    };
  }

  private buildCompletionRetryContextMessage(snapshot: CompletionRetrySnapshot | null): Message | null {
    if (!snapshot) return null;

    const lines = [
      '[Completion resume context]',
      `The previous attempt (${snapshot.attempt}) ended without a valid completion${snapshot.finishReason ? ` (finish reason: ${snapshot.finishReason})` : ''}.`,
      'Resume from the most advanced confirmed state below. Do not restart already completed actions unless the current page state contradicts them.',
      'Continue from that state, then either finish the task or report a concrete blocker. End by calling task_complete or task_blocked before your final answer.',
    ];

    if (snapshot.recentExternalToolSummaries.length > 0) {
      lines.push('', 'Confirmed external tool results from the previous attempt:');
      for (const summary of snapshot.recentExternalToolSummaries) {
        const prefix = summary.isError ? '[error]' : '[ok]';
        lines.push(`- ${summary.toolName}: ${prefix} ${summary.outputPreview}`);
      }
    }

    if (snapshot.partialContent) {
      lines.push(
        '',
        'Partial assistant text emitted before the attempt ended:',
        snapshot.partialContent,
      );
    }

    return {
      id: `system:completion-retry:${snapshot.attempt}`,
      role: 'system',
      content: lines.join('\n'),
      timestamp: 0,
      metadata: {
        transient: true,
        source: 'completion-resume',
      },
    };
  }

  private formatToolOutputPreview(output: string): string {
    return this.truncateResumeText(output, 180)
      .replace(/\s+/g, ' ')
      .trim();
  }

  private truncateResumeText(text: string, maxChars: number): string {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  private recordAttemptToolSummary(
    completionState: AttemptCompletionState,
    toolName: string,
    result: ToolResult,
  ): void {
    completionState.recentExternalToolSummaries.push({
      toolName,
      outputPreview: this.formatToolOutputPreview(result.output),
      isError: result.isError,
    });
    if (completionState.recentExternalToolSummaries.length > 6) {
      completionState.recentExternalToolSummaries.splice(0, completionState.recentExternalToolSummaries.length - 6);
    }
  }

  private evaluateCompletionGuard(
    displayContent: string,
    finishMeta: StreamFinishMetadata | undefined,
    completionState: AttemptCompletionState,
  ): CompletionGuardFailure | null {
    const trimmedContent = displayContent.trim();
    const hadExternalToolActivity = completionState.externalToolCallCount > 0;
    const endedOnToolCalls = finishMeta?.finishReason === 'tool-calls'
      || finishMeta?.stepFinishReasons.at(-1) === 'tool-calls';

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
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - this.lastStreamActivityAt) / 1000));
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

  private startStreamWatchdog(): void {
    this.stopStreamWatchdog();
    this.markStreamWaitingModel();

    this.streamWatchdog = setInterval(() => {
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
        // Cerebellum dropped mid-stream — abort the current turn
        this.emitWatchdog(
          'abort_issued',
          'Cerebellum disconnected during an active stream; aborting the turn.',
          { level: 'warn', elapsedSeconds },
        );
        this.abortController?.abort();
        return;
      }

      this._nudgeInFlight = true;

      const doNudge = () => {
        this.streamNudgeCount++;
        this.emitWatchdog(
          'nudge_requested',
          `Cerebellum requested nudge ${this.streamNudgeCount}/${this.maxNudgeRetries} after ${elapsedSeconds}s while ${this.describeStreamLocation()}.`,
          { level: 'info', elapsedSeconds },
        );
        this.emit({ type: 'cerebrum:stall:nudge', attempt: this.streamNudgeCount, ...diagnostics });
        this.emitWatchdog(
          'abort_issued',
          `Aborting stalled stream attempt ${this.currentStreamTurn?.attempt ?? 0}.`,
          { level: 'warn', elapsedSeconds },
        );
        this.abortController?.abort();
      };

      void (async () => {
        try {
          const result = await this.cerebellum!.verifyToolResult(
            'stream_watchdog',
            { action: 'check_stall', elapsed: String(elapsedSeconds) },
            `Stream silent for ${elapsedSeconds}s — no chunks or tool calls received`,
            false, // claimedSuccess=false → deterministic check fails → passed=false → nudge
          );

          // Cerebellum decides: passed=false → nudge. passed=true → wait.
          // null (disconnected mid-call) → nudge as safety fallback.
          if (!result || !result.passed) {
            doNudge();
          }
        } catch {
          // gRPC error (including deadline exceeded) → nudge
          doNudge();
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

  async sendMessage(content: string, conversationId?: string): Promise<void> {
    if (!this.cerebrum) throw new Error('Cerebrum not connected');
    if (this.cerebellum && !this.cerebellum.isConnected()) {
      throw new Error('Cerebellum is offline. Fix the Cerebellum connection before continuing. Run: docker compose up -d cerebellum');
    }

    const convId = conversationId ?? this.activeConversationId;
    if (!convId) throw new Error('No active conversation');

    if (content) {
      const userMessage = this.conversations.appendMessage(convId, 'user', content);
      this.emit({ type: 'message:user', message: userMessage });
    }

    this.streamNudgeCount = 0;
    let completionRetryCount = 0;
    let nextRetryContext: Message | null = null;
    const turnId = nanoid(10);
    const maxTotalAttempts = 1 + this.maxNudgeRetries + this.maxCompletionRetries;
    let loopTerminated = false;
    let nextRetryCause: RetryCause | null = null;

    try {
      for (let attempt = 0; attempt < maxTotalAttempts; attempt++) {
        const abortController = new AbortController();
        const attemptNumber = attempt + 1;
        const retryCause = nextRetryCause;
        nextRetryCause = null;
        const completionState = this.createAttemptCompletionState();
        let completionGuardFailure: CompletionGuardFailure | null = null;
        const stallRetryCountAtStart = this.streamNudgeCount;
        const isCurrentAttempt = () => this.abortController === abortController;
        this.abortController = abortController;
        this.currentAttemptCompletionState = completionState;
        this.currentStreamTurn = {
          turnId,
          attempt: attemptNumber,
          conversationId: convId,
        };
        log.info('stream_started', {
          turnId,
          attempt: attemptNumber,
          conversationId: convId,
          stallRetryCount: this.streamNudgeCount,
          completionRetryCount,
          retryCause,
        });
        this.emit({ type: 'message:cerebrum:start', conversationId: convId });
        this.startStreamWatchdog();

        let messages = this.conversations.getMessages(convId);

        // Context window compaction
        if (
          this.compactionConfig.enabled &&
          this.cerebrum?.summarize &&
          shouldCompact(messages, this.compactionConfig.contextWindow, this.compactionConfig.threshold)
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
        const throwIfToolAttemptAborted = () => {
          if (!isCurrentAttempt()) {
            throw createAbortError('Tool execution aborted');
          }
          throwIfAborted(abortController.signal, 'Tool execution aborted');
        };

        try {
          const streamPromise = this.cerebrum.stream(allMessages, toolDefs, {
            onChunk: (chunk) => {
              if (!isCurrentAttempt() || abortController.signal.aborted) return;
              fullContent += chunk;
              this.markStreamWaitingModel();
              this.emit({ type: 'message:cerebrum:chunk', chunk });
            },
            onToolCall: async (toolCall) => {
              throwIfToolAttemptAborted();
              this.logStreamDebug('tool_callback_started', {
                toolName: toolCall.name.trim() || toolCall.name,
                toolCallId: toolCall.id,
              });

              this.markStreamWaitingTool(toolCall);
              const requestedToolName = toolCall.name;
              const normalizedToolName = requestedToolName.trim() || requestedToolName;
              const isInternalTaskSignal = this.isInternalTaskSignalTool(normalizedToolName);
              if (isInternalTaskSignal) {
                completionState.internalToolCallCount++;
              } else {
                completionState.externalToolCallCount++;
                this.emit({ type: 'message:cerebrum:toolcall', toolCall: { ...toolCall, name: normalizedToolName } });
                this.emit({ type: 'tool:start', callId: toolCall.id, name: normalizedToolName });
              }

              const { toolName, result } = await this.toolRuntime.execute({
                toolCall,
                tools: allTools,
                conversationId: convId,
                sessionKey: 'agent:main',
                scopeKey: convId,
                abortSignal: abortController.signal,
              });
              this.logStreamDebug('tool_callback_finished', {
                toolName,
                toolCallId: toolCall.id,
                isError: result.isError,
              });

              throwIfAborted(abortController.signal, 'Tool execution aborted');

              this.markStreamWaitingModel();
              if (!isInternalTaskSignal) {
                this.emit({ type: 'tool:end', result });
              }

              if (!isInternalTaskSignal && !result.isError) {
                completionState.successfulExternalToolCount++;
              }

              // Cerebellum verification (non-blocking)
              if (!isInternalTaskSignal && this.cerebellum?.isConnected() && this.verificationEnabled) {
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
                    const vResult: VerificationResult = {
                      passed: verification.passed,
                      checks: verification.checks,
                      modelVerdict: verification.modelVerdict,
                      toolCallId: toolCall.id,
                      toolName,
                    };
                    this.emit({ type: 'verification:end', result: vResult });
                  }
                } catch {
                  // Verification failure should never block tool execution
                }
              }

              throwIfToolAttemptAborted();

              if (!isInternalTaskSignal) {
                this.recordAttemptToolSummary(completionState, toolName, result);
                this.conversations.appendMessage(convId, 'tool', result.output, {
                  toolResult: result,
                  metadata: {
                    toolName,
                    ...(requestedToolName !== toolName ? { requestedToolName } : {}),
                  },
                });
              }

              return result;
            },
            onFinish: (content, toolCalls, finishMeta) => {
              if (!isCurrentAttempt() || abortController.signal.aborted) return;
              this.stopStreamWatchdog();
              let displayContent = content;
              const visibleToolCalls = toolCalls?.filter((toolCall) => !this.isInternalTaskSignalTool(toolCall.name));

              log.info('stream_finish_observed', {
                turnId,
                attempt: attemptNumber,
                conversationId: convId,
                finishReason: finishMeta?.finishReason,
                rawFinishReason: finishMeta?.rawFinishReason,
                stepCount: finishMeta?.stepCount ?? 0,
                chunkCount: finishMeta?.chunkCount ?? 0,
                toolCallCount: finishMeta?.toolCallCount ?? 0,
                textChars: finishMeta?.textChars ?? content.length,
                completionSignal: completionState.signal,
              });

              // Check for discovery completion — parse and strip the tag before storing
              if (this.discoveryMode && content.includes('<discovery_complete>')) {
                const parsed = this.parseDiscoveryCompletion(content);
                // Strip the tag block from the displayed/stored content
                displayContent = content
                  .replace(/<discovery_complete>[\s\S]*?<\/discovery_complete>/g, '')
                  .trim();
                if (parsed && this.onDiscoveryComplete) {
                  this.discoveryMode = false;
                  this.onDiscoveryComplete(parsed);
                  log.info('Discovery completed', { name: parsed.name });
                }
              }

              const guardFailure = this.evaluateCompletionGuard(displayContent, finishMeta, completionState);
              if (guardFailure) {
                completionGuardFailure = guardFailure;
                nextRetryContext = this.buildCompletionRetryContextMessage(this.buildCompletionRetrySnapshot({
                  attempt: attemptNumber,
                  partialContent: fullContent || displayContent,
                  completionState,
                  finishMeta,
                }));
                if (nextRetryContext) {
                  log.info('completion_retry_context_prepared', {
                    turnId,
                    attempt: attemptNumber,
                    conversationId: convId,
                    finishReason: finishMeta?.finishReason,
                    rawFinishReason: finishMeta?.rawFinishReason,
                    hasPartialContent: (fullContent || displayContent).trim().length > 0,
                    recentToolSummaries: completionState.recentExternalToolSummaries.length,
                  });
                }
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
                  stepCount: finishMeta?.stepCount ?? 0,
                  chunkCount: finishMeta?.chunkCount ?? 0,
                  toolCallCount: finishMeta?.toolCallCount ?? 0,
                  textChars: finishMeta?.textChars ?? displayContent.length,
                  completionSignal: completionState.signal,
                });
                return;
              }

              const cerebrumMessage = this.conversations.appendMessage(
                convId, 'cerebrum', displayContent,
                visibleToolCalls?.length ? { toolCalls: visibleToolCalls } : undefined,
              );
              this.emit({ type: 'message:cerebrum:end', message: cerebrumMessage });
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
          }, { abortSignal: abortController.signal });
          await this.awaitStreamAttempt(streamPromise, abortController);

          const completionFailure = completionGuardFailure as CompletionGuardFailure | null;
          if (completionFailure !== null) {
            const completionSignal = completionFailure.signal;
            if (completionRetryCount < this.maxCompletionRetries) {
              completionRetryCount++;
              const systemMessage = this.conversations.appendMessage(
                convId,
                'system',
                COMPLETION_RETRY_PROMPT,
              );
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

            const diagnosticMessage = this.conversations.appendMessage(
              convId,
              'system',
              '[Cerebellum] The turn ended repeatedly without a valid completion signal or final answer.',
            );
            this.emit({ type: 'message:system', message: diagnosticMessage });
            this.emitCompletionTrace(
              'retry_failed',
              `Completion retries exhausted after ${completionRetryCount}/${this.maxCompletionRetries}: ${completionFailure.message}`,
              completionSignal,
              'error',
            );
            this.emit({
              type: 'error',
              error: new Error('Turn ended without a valid completion signal or final answer.'),
            });
            loopTerminated = true;
            break;
          }
          loopTerminated = true;
          break; // success — exit retry loop
        } catch (error) {
          const failureState = this.getStreamState();
          this.stopStreamWatchdog();

          // Check if this was a nudge-abort (not emergency stop, not a real error)
          const isNudgeAbort =
            abortController.signal.aborted
            && this.streamNudgeCount > stallRetryCountAtStart
            && this.streamNudgeCount <= this.maxNudgeRetries;

          if (isNudgeAbort) {
            nextRetryContext = this.buildStallRetryContextMessage(this.buildStallRetrySnapshot({
              attempt: attemptNumber,
              phase: failureState.phase,
              activeToolName: failureState.activeToolName,
              activeToolCallId: failureState.activeToolCallId,
              partialContent: fullContent,
              completionState,
            }));
            // Inject nudge message and retry via the loop
            const systemMessage = this.conversations.appendMessage(
              convId, 'system',
              '[Cerebellum] You stopped mid-response. Continue from where you left off.',
            );
            this.emit({ type: 'message:system', message: systemMessage });
            this.emitWatchdog(
              'retry_started',
              `Retrying stalled turn with attempt ${attemptNumber + 1} (stall retry ${this.streamNudgeCount}/${this.maxNudgeRetries}).`,
              { level: 'info' },
            );
            nextRetryCause = 'stall';
            continue; // retry loop
          }

          // Check if Cerebellum dropped mid-stream
          if (this.cerebellum && !this.cerebellum.isConnected() && abortController.signal.aborted) {
            const err = new Error('Cerebellum disconnected during active response. Restart it with: docker compose up -d cerebellum');
            log.error('Cerebellum disconnected mid-stream', { error: err.message });
            this.emit({ type: 'error', error: err });
            loopTerminated = true;
            break;
          }

          const err = error instanceof Error ? error : new Error(String(error));
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
