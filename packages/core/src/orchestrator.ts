import { nanoid } from 'nanoid';
import { TypedEventEmitter } from './events.js';
import { ConversationStore } from './conversation.js';
import { SubAgentManager } from './sub-agent-manager.js';
import { createSubAgentTools } from './sub-agent-tools.js';
import { createLogger } from './logger.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { Message, ToolCall, ToolResult, VerificationResult, AgentHealthAction } from './types.js';
import { estimateMessageTokens, shouldCompact, buildCompactionMessages } from './context.js';
import type { InstanceStore, FineTuneRecord } from './instance.js';
import {
  ToolRuntime,
  type ToolExecutionContext,
  type ToolExecutionValue,
  type ToolRuntimeConfig,
} from './tool-runtime.js';

const log = createLogger('orchestrator');

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
  onFinish: (content: string, toolCalls?: ToolCall[]) => void;
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
    if (options?.compaction) {
      this.compactionConfig = { ...this.compactionConfig, ...options.compaction };
    }
    if (options?.streamStallThreshold) this.streamStallThreshold = options.streamStallThreshold * 1000;
    if (options?.maxNudgeRetries) this.maxNudgeRetries = options.maxNudgeRetries;
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

  registerTool(name: string, tool: ToolDefinition): void {
    this.tools.set(name, tool);
  }

  registerTools(tools: Record<string, ToolDefinition>): void {
    for (const [name, tool] of Object.entries(tools)) {
      this.tools.set(name, tool);
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
      tools: this.tools,
      conversationId: options?.conversationId,
      sessionKey: options?.sessionKey,
      scopeKey: options?.scopeKey,
    });
  }

  unregisterTool(name: string): boolean {
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
    return {
      streaming: this.streamWatchdog !== null,
      lastActivityAt: this.lastStreamActivityAt,
      stallDetected: this.streamWatchdog !== null && (Date.now() - this.lastStreamActivityAt) > this.streamStallThreshold,
      nudgeCount: this.streamNudgeCount,
    };
  }

  private startStreamWatchdog(): void {
    this.stopStreamWatchdog();
    this.lastStreamActivityAt = Date.now();

    this.streamWatchdog = setInterval(() => {
      const elapsed = Date.now() - this.lastStreamActivityAt;
      if (elapsed < this.streamStallThreshold) return;
      if (this.streamNudgeCount >= this.maxNudgeRetries) return;
      if (this._nudgeInFlight) return;

      const elapsedSeconds = Math.round(elapsed / 1000);
      this.emit({ type: 'cerebrum:stall', elapsedSeconds });

      if (!this.cerebellum?.isConnected()) {
        // Cerebellum dropped mid-stream — abort the current turn
        log.warn('Cerebellum disconnected during active stream — aborting');
        this.abortController?.abort();
        return;
      }

      this._nudgeInFlight = true;

      const doNudge = () => {
        this.streamNudgeCount++;
        log.info('Cerebellum nudging stalled stream', { elapsed: elapsedSeconds, attempt: this.streamNudgeCount });
        this.emit({ type: 'cerebrum:stall:nudge', attempt: this.streamNudgeCount });
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

    // Retry loop — nudge aborts land here for retry
    for (let attempt = 0; attempt <= this.maxNudgeRetries; attempt++) {
    this.abortController = new AbortController();
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
    const basePrompt = buildSystemPrompt({
      cerebellumConnected: this.cerebellum?.isConnected() ?? false,
      tools: this.tools,
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

    const allMessages: Message[] = [
      { id: 'system', role: 'system' as const, content: fullSystemPrompt, timestamp: 0 },
      ...messages,
    ];

    const toolDefs = Object.fromEntries(this.tools);
    let fullContent = '';

    try {
      await this.cerebrum.stream(allMessages, toolDefs, {
        onChunk: (chunk) => {
          fullContent += chunk;
          this.lastStreamActivityAt = Date.now();
          this.emit({ type: 'message:cerebrum:chunk', chunk });
        },
        onToolCall: async (toolCall) => {
          this.lastStreamActivityAt = Date.now();
          const requestedToolName = toolCall.name;
          const normalizedToolName = requestedToolName.trim() || requestedToolName;
          this.emit({ type: 'message:cerebrum:toolcall', toolCall: { ...toolCall, name: normalizedToolName } });
          this.emit({ type: 'tool:start', callId: toolCall.id, name: normalizedToolName });

          const { toolName, result } = await this.toolRuntime.execute({
            toolCall,
            tools: this.tools,
            conversationId: convId,
            sessionKey: 'agent:main',
            scopeKey: convId,
          });

          this.lastStreamActivityAt = Date.now();
          this.emit({ type: 'tool:end', result });

          // Cerebellum verification (non-blocking)
          if (this.cerebellum?.isConnected() && this.verificationEnabled) {
            try {
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

          this.conversations.appendMessage(convId, 'tool', result.output, {
            toolResult: result,
            metadata: {
              toolName,
              ...(requestedToolName !== toolName ? { requestedToolName } : {}),
            },
          });

          return result;
        },
        onFinish: (content, toolCalls) => {
          this.stopStreamWatchdog();
          let displayContent = content;

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

          const cerebrumMessage = this.conversations.appendMessage(
            convId, 'cerebrum', displayContent,
            toolCalls?.length ? { toolCalls } : undefined,
          );
          this.emit({ type: 'message:cerebrum:end', message: cerebrumMessage });
        },
        onError: (error) => {
          this.stopStreamWatchdog();
          // Don't log/emit if this is an intentional nudge-abort — the catch block handles retry
          if (this.abortController?.signal.aborted && this.streamNudgeCount > 0) return;
          log.error('Cerebrum stream error', { error: error.message });
          this.emit({ type: 'error', error });
        },
      }, { abortSignal: this.abortController?.signal });
    } catch (error) {
      this.stopStreamWatchdog();

      // Check if this was a nudge-abort (not emergency stop, not a real error)
      const isNudgeAbort = this.abortController?.signal.aborted && this.streamNudgeCount > 0 && this.streamNudgeCount <= this.maxNudgeRetries;

      if (isNudgeAbort) {
        // Inject nudge message and retry via the for-loop
        this.conversations.appendMessage(
          convId, 'system',
          '[Cerebellum] You stopped mid-response. Continue from where you left off.',
        );
        continue; // retry loop
      }

      // Check if Cerebellum dropped mid-stream
      if (this.cerebellum && !this.cerebellum.isConnected() && this.abortController?.signal.aborted) {
        const err = new Error('Cerebellum disconnected during active response. Restart it with: docker compose up -d cerebellum');
        log.error('Cerebellum disconnected mid-stream', { error: err.message });
        this.emit({ type: 'error', error: err });
        break;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Send message failed', { error: err.message });
      this.emit({ type: 'error', error: err });
    }

    break; // success — exit retry loop
    } // end retry for-loop
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
