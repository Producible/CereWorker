import { execFileSync, execSync, spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Orchestrator,
  ConversationStore,
  PairingStore,
  InstanceStore,
  PlanStore,
  TaskStore,
  ProactiveController,
  createLogger,
  createHttpTools,
  normalizeTaskSchedule,
  formatTaskSchedule,
  taskScheduleToHint,
  getNextTaskRun,
  type TaskDefinition,
  type TaskRunRecord,
  type TaskSchedule,
  type TaskReportTarget,
  type SchedulerStatus,
} from '@cereworker/core';
import {
  CerebellumClient,
  type TaskSchedule as CerebellumTaskSchedule,
  type SupervisorState as CerebellumSupervisorState,
  type SupervisorTaskState as CerebellumSupervisorTaskState,
  type TaskAction as CerebellumTaskAction,
} from '@cereworker/cerebellum-client';
import { CerebrumProvider, createBuiltinTools } from '@cereworker/cerebrum';
import type { CereWorkerConfig } from '@cereworker/config';
import { createChannelManager, type ChannelManager } from '@cereworker/channels';
import { createBrowserTools, PuppeteerBackend, CdpBackend, BrowserRelay, ExtensionBackend } from '@cereworker/browser';
import { loadSkills, filterEligibleSkills, SkillRegistry } from '@cereworker/skills';
import { parseCommand, handleSlashCommand, CHANNEL_COMMANDS, type CommandContext } from './commands.js';
import {
  HippocampusStore,
  HippocampusCurator,
  ConversationExtractor,
  FineTuneArchiveStore,
  createMemoryTools,
  memoryReadParameters,
  memoryWriteParameters,
  memoryLogParameters,
  memorySearchParameters,
  type TrainingCandidate,
} from '@cereworker/hippocampus';
import {
  GatewayServer,
  GatewayNodeClient,
  createProxyTools,
  type AnyGatewayFrame,
  type RemoteToolExecutionContext,
} from '@cereworker/gateway';
import {
  buildCerebellumComposeCommand,
  buildCerebellumComposeEnv,
  resolveCerebellumDockerModel,
} from './cerebellum-docker.js';
import {
  buildChannelConversationKey,
  loadChannelConversationState,
  saveChannelConversationState,
} from './channel-conversations.js';

const log = createLogger('service');

export interface GatewayCallbacks {
  onNodeConnected?: (nodeId: string, nodeCount: number) => void;
  onNodeDisconnected?: (nodeId: string, nodeCount: number) => void;
}

export interface GatewayHandles {
  server: GatewayServer | null;
  client: GatewayNodeClient | null;
}

export interface TaskStateEntry {
  conversationId: string;
  lastRunAt?: string;
  runCount?: number;
}

export interface ServiceInstance {
  orchestrator: Orchestrator;
  channelManager: ChannelManager;
  cerebrum: CerebrumProvider;
  skillRegistry: SkillRegistry;
  pairingStore: PairingStore;
  instanceStore: InstanceStore;
  proactiveController: ProactiveController | null;
  needsDiscovery: boolean;
  startChannels(): Promise<number>;
  startCerebellum(): Promise<{ ok: true } | { ok: false; reason: string }>;
  startGateway(callbacks?: GatewayCallbacks): Promise<GatewayHandles>;
  runTask(taskId: string): Promise<{ success: boolean; error?: string }>;
  getTaskState(): Record<string, TaskStateEntry>;
  getTaskDefinitions(): TaskDefinition[];
  getTaskRuns(taskId: string): TaskRunRecord[];
  getEnabledTasks(): Array<{ id: string; goal: string; schedule: string; autoMode: boolean; timeoutMinutes: number }>;
  listHeartbeatTasks(): Promise<Array<{ taskId: string; description: string; status: string; lastRun?: number; scheduleHint: string; metadata?: Record<string, string> }>>;
  shutdown(): Promise<void>;
}

export interface ServiceDeps {
  createCerebrum?: (
    config: ConstructorParameters<typeof CerebrumProvider>[0],
    options: ConstructorParameters<typeof CerebrumProvider>[1],
  ) => CerebrumProvider;
  createChannelManager?: typeof createChannelManager;
  createCerebellumClient?: (address: string) => CerebellumClient;
  execSync?: typeof execSync;
  execFileSync?: typeof execFileSync;
  spawn?: (command: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;
  homeDir?: () => string;
}

export function createService(config: CereWorkerConfig, deps: ServiceDeps = {}): ServiceInstance {
  const execSyncImpl = deps.execSync ?? execSync;
  const execFileSyncImpl = deps.execFileSync ?? execFileSync;
  const spawnImpl = deps.spawn ?? spawn;
  const homeDir = deps.homeDir ?? homedir;
  const dataDir = join(homeDir(), '.cereworker');
  const dataDbPath = join(dataDir, 'conversations.db');
  const createCerebrumImpl = deps.createCerebrum
    ?? ((providerConfig, options) => new CerebrumProvider(providerConfig, options));
  const createChannelManagerImpl = deps.createChannelManager ?? createChannelManager;
  const createCerebellumClientImpl = deps.createCerebellumClient
    ?? ((address: string) => new CerebellumClient(address));

  // Create persistent conversation store
  const conversationStore = new ConversationStore(dataDbPath);
  const planStore = new PlanStore(dataDbPath);

  // Instance identity
  const instanceStore = new InstanceStore(dataDir);
  let instance = instanceStore.load();
  let needsDiscovery = false;
  if (instance) {
    instanceStore.updateBoot();
    // If config profile changed and instance was static, update it
    if (instance.profile.source === 'static') {
      const cp = config.profile;
      if (cp.name !== instance.profile.name || cp.role !== instance.profile.role) {
        instanceStore.updateProfile({ name: cp.name, role: cp.role, traits: cp.traits });
        instance = instanceStore.get()!;
      }
    }
  } else {
    // No instance yet — create from config or flag for discovery
    instance = instanceStore.create(config.profile, 'static');
    // Populate conversation count from existing DB
    const existing = conversationStore.list();
    if (existing.length > 0) {
      instanceStore.setConversationCount(existing.length);
    }
    needsDiscovery = true;
  }
  const instanceId = instance.id;

  const orchestrator = new Orchestrator({
    conversationStore,
    compaction: {
      enabled: config.cerebrum.compaction.enabled,
      threshold: config.cerebrum.compaction.threshold,
      keepRecentMessages: config.cerebrum.compaction.keepRecentMessages,
      contextWindow: config.cerebrum.contextWindow,
    },
    toolRuntime: config.tools.runtime,
    streamStallThreshold: config.cerebrum.streamStallThreshold,
    maxNudgeRetries: config.cerebrum.maxNudgeRetries,
    turnJournalRetention: config.conversations.turnJournals,
  });

  const cerebrumConfig = {
    defaultProvider: config.cerebrum.defaultProvider,
    defaultModel: config.cerebrum.defaultModel,
    providers: config.cerebrum.providers as Record<string, { apiKey?: string; baseUrl?: string; model?: string }>,
    maxSteps: config.cerebrum.maxSteps,
    temperature: config.cerebrum.temperature,
  };

  const cerebrum = createCerebrumImpl(cerebrumConfig, {
    denyList: config.tools.shell.denyList,
    timeout: config.tools.shell.timeout,
    maxOutputSize: config.tools.shell.maxOutputSize,
    autoMode: config.tools.shell.autoMode,
  });

  // Set initial auto mode on orchestrator
  orchestrator.setAutoMode(config.tools.shell.autoMode);

  // Set worker profile from instance identity (overrides config)
  orchestrator.setProfile(instance!.profile);
  orchestrator.setInstanceStore(instanceStore);

  // Bridge CerebrumProvider to Orchestrator's CerebrumAdapter interface
  orchestrator.setCerebrum({
    stream: async (...args: Parameters<typeof cerebrum.stream>) => {
      await cerebrum.stream(...args);
    },
    summarize: async (messages) => {
      return cerebrum.summarize(messages);
    },
  });

  // Load and inject skills
  const skillRegistry = new SkillRegistry();
  const builtinSkillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
  const skillDirs = [
    ...config.skills.directories,
    builtinSkillsDir,
    join(homeDir(), '.cereworker', 'skills'),
    join(process.cwd(), 'skills'),
  ];
  const allSkills = loadSkills(skillDirs);
  const eligible = filterEligibleSkills(allSkills);
  skillRegistry.registerAll(eligible);

  const skillPrompt = skillRegistry.buildPrompt();
  if (skillPrompt) {
    orchestrator.setSystemContext(skillPrompt);
    log.info('Skills loaded', { count: eligible.length, total: allSkills.length });
  }

  const instanceTimezone = instanceStore.get()?.timezone
    ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const taskStore = new TaskStore(join(dataDir, 'tasks'));
  const legacyTaskStateFile = join(homeDir(), '.cereworker', 'task-state.json');

  const TASK_ID_MAX_LENGTH = 48;

  function buildNormalizedTaskId(value: string): string {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!normalized) {
      throw new Error('Task id must contain at least one letter or number.');
    }
    if (normalized.length <= TASK_ID_MAX_LENGTH) {
      return normalized;
    }

    const suffix = createHash('sha1')
      .update(value)
      .digest('hex')
      .slice(0, 8);
    const prefix = normalized
      .slice(0, TASK_ID_MAX_LENGTH - suffix.length - 1)
      .replace(/-+$/g, '');
    return `${prefix}-${suffix}`;
  }

  function normalizeTaskId(
    value: string,
    options: { reservedIds?: Set<string>; currentId?: string } = {},
  ): string {
    const normalized = buildNormalizedTaskId(value);
    if (options.reservedIds?.has(normalized) && normalized !== options.currentId) {
      throw new Error(`Task id collision for "${value}". Choose a more specific task id.`);
    }
    return normalized;
  }

  function normalizeConfiguredTask(
    task: CereWorkerConfig['tasks'][number],
    reservedIds: Set<string>,
  ): TaskDefinition {
    const now = new Date().toISOString();
    const schedule = normalizeTaskSchedule(task.schedule as string | TaskSchedule, {
      defaultTimezone: instanceTimezone,
      defaultCatchUpPolicy: 'once',
    });
    const kind = task.kind === 'recurring' && schedule.type === 'one_shot'
      ? 'one_shot'
      : task.kind;
    const id = normalizeTaskId(task.id, { reservedIds });
    reservedIds.add(id);
    return {
      id,
      goal: task.goal,
      enabled: task.enabled,
      kind,
      schedule,
      autoMode: task.autoMode,
      timeoutMinutes: task.timeoutMinutes,
      reportTarget: task.reportTarget ?? 'origin',
      createdAt: now,
      updatedAt: now,
      origin: {
        source: 'config',
        createdAt: now,
      },
      schedulerStatus: task.enabled ? 'pending_cerebellum' : 'disabled',
      timezone: schedule.type === 'interval' ? undefined : schedule.timezone,
    };
  }

  const configuredTaskIds = new Set<string>();
  const configuredTasks = config.tasks.map((task) => normalizeConfiguredTask(task, configuredTaskIds));
  for (const configuredTask of configuredTasks) {
    const existing = taskStore.get(configuredTask.id);
    if (!existing) {
      taskStore.upsert(configuredTask);
      continue;
    }
    if (existing.origin?.source === 'config') {
      taskStore.upsert({
        ...existing,
        goal: configuredTask.goal,
        enabled: configuredTask.enabled,
        kind: configuredTask.kind,
        schedule: configuredTask.schedule,
        autoMode: configuredTask.autoMode,
        timeoutMinutes: configuredTask.timeoutMinutes,
        reportTarget: configuredTask.reportTarget,
        updatedAt: new Date().toISOString(),
        schedulerStatus: existing.enabled ? existing.schedulerStatus ?? 'pending_cerebellum' : 'disabled',
        timezone: configuredTask.timezone,
      });
    }
  }

  type TaskState = Record<string, { conversationId: string; lastRunAt?: string; runCount?: number }>;
  const legacyTaskState: TaskState = existsSync(legacyTaskStateFile)
    ? JSON.parse(readFileSync(legacyTaskStateFile, 'utf-8'))
    : {};
  for (const [taskId, state] of Object.entries(legacyTaskState)) {
    const existing = taskStore.get(taskId);
    if (!existing) continue;
    const next = {
      ...existing,
      activeConversationId: existing.activeConversationId || state.conversationId || undefined,
      lastRunAt: existing.lastRunAt || state.lastRunAt,
      runCount: existing.runCount ?? state.runCount ?? 0,
    };
    taskStore.upsert(next);
  }

  function listActiveTasks(): TaskDefinition[] {
    return taskStore
      .list()
      .filter((task) => task.enabled && !(task.kind === 'one_shot' && task.lastResult === 'success'));
  }

  function refreshOrchestratorTaskPrompt(): void {
    const activeTasks = listActiveTasks();
    orchestrator.setRecurringTasks(activeTasks.map((task) => ({
      id: task.id,
      goal: task.goal,
      schedule: formatTaskSchedule(task.schedule),
    })));
    if (activeTasks.length > 0) {
      log.info('Routine tasks configured', { count: activeTasks.length });
    }
  }

  function restoreTaskConversations(): void {
    for (const task of taskStore.list()) {
      if (task.activeConversationId) {
        orchestrator.setTaskConversation(task.id, task.activeConversationId);
      }
    }
  }

  restoreTaskConversations();
  refreshOrchestratorTaskPrompt();

  const channelConversationStateFile = join(homeDir(), '.cereworker', 'channel-conversations.json');
  let channelConversationState = loadChannelConversationState(channelConversationStateFile);

  for (const [sessionKey, conversationId] of Object.entries(channelConversationState)) {
    if (!conversationStore.get(conversationId)) {
      delete channelConversationState[sessionKey];
    }
  }
  saveChannelConversationState(channelConversationStateFile, channelConversationState);

  function saveChannelConversationMap(): void {
    try {
      saveChannelConversationState(channelConversationStateFile, channelConversationState);
    } catch (err) {
      log.warn('Failed to save channel conversation state', { error: (err as Error).message });
    }
  }

  function getOrCreateChannelConversationId(msg: { channelId: string; senderId: string; sessionId?: string; threadId?: string }): string {
    const sessionKey = buildChannelConversationKey(msg);
    const existingConversationId = channelConversationState[sessionKey];
    if (existingConversationId && conversationStore.get(existingConversationId)) {
      return existingConversationId;
    }

    const conversation = conversationStore.create();
    channelConversationState[sessionKey] = conversation.id;
    instanceStore.incrementConversation();
    saveChannelConversationMap();
    log.info('Started channel conversation', {
      conversationId: conversation.id,
      sessionKey,
      channelId: msg.channelId,
      senderId: msg.senderId,
    });
    return conversation.id;
  }

  // Register hippocampus (memory) tools
  let hippocampusStore: HippocampusStore | null = null;
  if (config.hippocampus.enabled) {
    hippocampusStore = new HippocampusStore(config.hippocampus.directory);
    const memoryTools = createMemoryTools(hippocampusStore);

    orchestrator.registerTool('memory_read', {
      description: 'Read a memory file (MEMORY.md or a daily log like 2026-03-08.md)',
      parameters: memoryReadParameters as unknown as Record<string, unknown>,
      execute: async (args) => memoryTools.executeMemoryRead(args as { file: string }),
    });
    orchestrator.registerTool('memory_write', {
      description: 'Write/update the main MEMORY.md file with curated long-term notes',
      parameters: memoryWriteParameters as unknown as Record<string, unknown>,
      execute: async (args) => memoryTools.executeMemoryWrite(args as { content: string }),
    });
    orchestrator.registerTool('memory_log', {
      description: "Append a note to today's daily log",
      parameters: memoryLogParameters as unknown as Record<string, unknown>,
      execute: async (args) => memoryTools.executeMemoryLog(args as { content: string }),
    });
    orchestrator.registerTool('memory_search', {
      description: 'Search across all memory files for a text pattern',
      parameters: memorySearchParameters as unknown as Record<string, unknown>,
      execute: async (args) => memoryTools.executeMemorySearch(args as { query: string }),
    });
  }

  const fineTuneArchive = new FineTuneArchiveStore(
    hippocampusStore?.finetuneDir ?? join(dataDir, 'finetune'),
  );

  const builtinTools = createBuiltinTools({
    enabled: config.tools.shell.enabled,
    denyList: config.tools.shell.denyList,
    timeout: config.tools.shell.timeout,
    maxOutputSize: config.tools.shell.maxOutputSize,
    autoMode: config.tools.shell.autoMode,
  });

  if (config.tools.shell.enabled) {
    orchestrator.registerTool('shell', builtinTools.shell);
  }

  if (config.tools.fileOps.enabled) {
    orchestrator.registerTools({
      readFile: builtinTools.readFile,
      writeFile: builtinTools.writeFile,
      listDirectory: builtinTools.listDirectory,
      editFile: builtinTools.editFile,
      searchFiles: builtinTools.searchFiles,
      glob: builtinTools.glob,
    });
  }

  // Setup fine-tune data provider (Instinct pillar)
  const scheduleMap: Record<string, string> = {
    auto: 'when idle',
    hourly: 'every hour',
    daily: 'every day',
    weekly: 'every week',
  };
  let finetuneScheduleHint = scheduleMap[config.cerebellum.finetune?.schedule ?? 'auto'] ?? 'when idle';
  let pendingFineTuneBatch: import('@cereworker/hippocampus').FineTuneQueuedBatch | null = null;
  const fineTuneRoundsByJob = new Map<string, string>();
  let fineTuneActive = false;

  if (config.cerebellum.finetune?.enabled) {
    const conversationExtractor = new ConversationExtractor(
      conversationStore,
      fineTuneArchive.getConversationExtractorStatePath(),
      instanceId,
    );

    // Memory-based curator (requires hippocampus)
    const curator = config.hippocampus.enabled
      ? new HippocampusCurator(
          hippocampusStore!,
          { generate: (prompt: string) => cerebrum.generate(prompt) },
          instanceId,
        )
      : null;

    orchestrator.setFineTuneDataProvider(async () => {
      if (curator) {
        await curator.curate();
      }

      const convPairs = conversationExtractor.extractPairs();
      if (convPairs.length > 0) {
        fineTuneArchive.enqueue('conversations', convPairs);
      }

      pendingFineTuneBatch = fineTuneArchive.getQueuedBatch();
      return pendingFineTuneBatch.pairs;
    }, config.cerebellum.finetune.method);

    orchestrator.setFineTuneSchedule(config.cerebellum.finetune.schedule);
    log.info('Fine-tune data provider configured', { schedule: finetuneScheduleHint });
  }

  orchestrator.on('finetune:start', ({ jobId }) => {
    fineTuneActive = true;
    if (!pendingFineTuneBatch || pendingFineTuneBatch.pairs.length === 0) return;
    try {
      const manifest = fineTuneArchive.createRound(pendingFineTuneBatch, {
        jobId,
        requestedMethod: config.cerebellum.finetune?.method,
        instanceId,
        activeCheckpointBefore: instanceStore.get()?.activeCheckpoint ?? null,
      });
      fineTuneArchive.clearBatch(pendingFineTuneBatch);
      fineTuneRoundsByJob.set(jobId, manifest.roundId);
      pendingFineTuneBatch = null;
    } catch (err) {
      log.error('Failed to archive fine-tune round', { jobId, error: (err as Error).message });
    }
  });

  orchestrator.on('finetune:complete', ({ jobId, checkpointPath }) => {
    fineTuneActive = false;
    const roundId = fineTuneRoundsByJob.get(jobId);
    if (!roundId) return;
    void orchestrator.getFineTuneStatus()
      .then((status) => {
        fineTuneArchive.updateRoundStatus(roundId, {
          status: 'completed',
          completedAt: new Date(status.completedAt || Date.now()).toISOString(),
          checkpointPath,
          loss: status.currentLoss,
        });
        fineTuneRoundsByJob.delete(jobId);
      })
      .catch((err) => {
        fineTuneArchive.updateRoundStatus(roundId, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          checkpointPath,
        });
        fineTuneRoundsByJob.delete(jobId);
        log.warn('Failed to update fine-tune round completion metadata', {
          jobId,
          error: (err as Error).message,
        });
      });
  });

  orchestrator.on('finetune:error', ({ jobId, error }) => {
    fineTuneActive = false;
    const roundId = fineTuneRoundsByJob.get(jobId);
    if (!roundId) return;
    fineTuneArchive.updateRoundStatus(roundId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error,
    });
    fineTuneRoundsByJob.delete(jobId);
  });

  if (hippocampusStore) {
    const appendTrainingCandidate = (candidate: TrainingCandidate) => {
      hippocampusStore.appendTrainingCandidate({
        ...candidate,
        instanceId: candidate.instanceId ?? instance.id,
      });
    };

    const maybeAppendDailyContinuity = (conversationId: string, sessionId: string, reply: string) => {
      const session = orchestrator.getQuerySession(conversationId, sessionId);
      if (!session) return;
      const sessionEvents = orchestrator.getSessionEvents(conversationId, sessionId);
      const hasQualifyingActivity = sessionEvents.some((event) =>
        [
          'tool_finished',
          'recovery_assessed',
          'channel_ingress',
          'channel_egress',
          'node_tool_started',
          'node_tool_finished',
          'node_status',
        ].includes(event.type),
      );
      if (!hasQualifyingActivity) return;

      const boundarySummary = session.latestBoundary?.summary ?? 'No verified boundary recorded.';
      hippocampusStore.appendDailyLog([
        `Session ${sessionId} (${session.source})`,
        `State: ${session.state}`,
        `Outcome: ${session.lastOutcome ?? 'unknown'}`,
        `Latest boundary: ${boundarySummary}`,
        `Reply: ${reply.slice(0, 500)}`,
      ].join('\n'));
    };

    orchestrator.on('message:cerebrum:end', ({ conversationId, sessionId, message }) => {
      const messages = orchestrator.getMessages(conversationId);
      const latestUser = [...messages]
        .reverse()
        .find((candidate) => candidate.role === 'user');
      if (!latestUser) return;
      hippocampusStore.appendSessionTurn(conversationId, latestUser.content, message.content);
      orchestrator.recordSessionMemoryUpdate(conversationId, sessionId, {
        sessionId,
        updatedAt: Date.now(),
        summary: 'Stored the latest user/assistant exchange in session memory.',
        excerpt: message.content.slice(0, 500),
      });
      maybeAppendDailyContinuity(conversationId, sessionId, message.content);
      appendTrainingCandidate({
        kind: 'session',
        createdAt: Date.now(),
        source: `session:${conversationId}`,
        conversationId,
        sessionId,
        summary: 'Stored the completed session summary and reply trace.',
        data: {
          replyExcerpt: message.content.slice(0, 500),
        },
      });
    });

    orchestrator.on('cerebellum:recovery', (event) => {
      appendTrainingCandidate({
        kind: 'recovery',
        createdAt: Date.now(),
        source: `recovery:${event.cause}`,
        conversationId: event.conversationId,
        sessionId: event.turnId,
        summary: event.diagnosis,
        data: {
          cause: event.cause,
          action: event.action,
          completedSteps: event.completedSteps,
          nextStep: event.nextStep,
          source: event.source,
        },
      });
    });

    orchestrator.on('cerebrum:completion', (event) => {
      if (!['guard_triggered', 'retry_failed'].includes(event.stage)) return;
      appendTrainingCandidate({
        kind: 'completion',
        createdAt: Date.now(),
        source: `completion:${event.stage}`,
        conversationId: event.conversationId,
        sessionId: event.turnId,
        summary: event.message,
        data: {
          stage: event.stage,
          signal: event.signal,
          attempt: event.attempt,
        },
      });
    });

    orchestrator.on('verification:end', ({ result, conversationId, sessionId }) => {
      appendTrainingCandidate({
        kind: 'verification',
        createdAt: Date.now(),
        source: `verification:${result.toolName}`,
        conversationId,
        sessionId,
        summary: `Verification ${result.passed ? 'passed' : 'failed'} for ${result.toolName}.`,
        data: {
          toolName: result.toolName,
          toolCallId: result.toolCallId,
          passed: result.passed,
          modelVerdict: result.modelVerdict,
          checks: result.checks,
        },
      });
    });
  }

  // Setup sub-agents
  if (config.subAgents.enabled) {
    orchestrator.setupSubAgents({
      maxConcurrent: config.subAgents.maxConcurrent,
      monitorIntervalMs: config.subAgents.monitorIntervalSeconds * 1000,
    });
  }

  // Register HTTP and web search tools
  if (config.tools.http?.enabled !== false) {
    const httpTools = createHttpTools({
      timeout: config.tools.http?.timeout,
      maxResponseSize: config.tools.http?.maxResponseSize,
      allowPrivate: config.tools.http?.allowPrivate,
    });
    if (config.tools.web?.enabled !== false) {
      orchestrator.registerTools(httpTools);
    } else {
      // Register httpFetch only, skip webSearch
      orchestrator.registerTool('httpFetch', httpTools.httpFetch);
    }
  } else if (config.tools.web?.enabled !== false) {
    // HTTP disabled but web search enabled
    const httpTools = createHttpTools();
    orchestrator.registerTool('webSearch', httpTools.webSearch);
  }

  // Register browser tools with orchestrator
  let browserRelay: BrowserRelay | null = null;
  if (config.tools.browser.enabled) {
    const browserMode = config.tools.browser.mode;
    let backend;
    if (browserMode === 'extension') {
      const relay = new BrowserRelay({
        port: config.tools.browser.extension.relayPort,
        token: config.tools.browser.extension.token,
      });
      browserRelay = relay;
      backend = new ExtensionBackend(relay);
    } else if (browserMode === 'connect') {
      backend = new CdpBackend({ port: config.tools.browser.cdpPort });
    } else {
      backend = new PuppeteerBackend({ headless: config.tools.browser.headless });
    }
    const browserTools = createBrowserTools(backend);
    for (const [name, toolDef] of Object.entries(browserTools)) {
      orchestrator.registerTool(name, {
        description: toolDef.description,
        parameters: toolDef.parameters as unknown as Record<string, unknown>,
        execute: async (args, context) => toolDef.execute(args as never, context),
      });
    }
  }

  // Create channel manager
  const channelManager = createChannelManagerImpl(config, CHANNEL_COMMANDS);

  // Create pairing store and wire to channel manager
  const pairingStore = new PairingStore(dataDbPath);
  channelManager.setDmPolicy(config.channels.dmPolicy);
  channelManager.setPairingProvider(pairingStore);

  const heartbeatTaskMap = new Map<string, { type: 'finetune' }>();

  function toCerebellumTaskSchedule(schedule: TaskSchedule): CerebellumTaskSchedule {
    return { ...schedule };
  }

  function getDesiredSchedulerStatus(task: TaskDefinition): SchedulerStatus {
    if (task.lastResult === 'running' || orchestrator.isTaskRunning(task.id)) {
      return 'running';
    }
    if (!task.enabled || (task.kind === 'one_shot' && task.lastResult === 'success')) {
      return 'disabled';
    }
    return cerebellumClient?.isConnected() ? 'registered' : 'pending_cerebellum';
  }

  function shouldSyncTaskWithCerebellum(task: TaskDefinition): boolean {
    return task.enabled && !(task.kind === 'one_shot' && task.lastResult === 'success');
  }

  function deriveTaskMetadata(task: TaskDefinition): Record<string, string> {
    const goal = task.goal.toLowerCase();
    const requiresBrowser =
      /\bbrowser\b|\bchrome\b|x\.com|\btimeline\b|\bmanage (?:the )?x account\b|\bpost on x\b|\bdaily x update\b|\bx update\b|\blike \d+(?:-\d+)? relevant\b/.test(goal);
    return {
      taskId: task.id,
      taskKind: task.kind,
      reportTarget: task.reportTarget,
      requiresBrowser: requiresBrowser ? 'true' : 'false',
    };
  }

  function toSupervisorTaskState(task: TaskDefinition): CerebellumSupervisorTaskState {
    return {
      taskId: task.id,
      description: task.goal.split('\n')[0] || task.goal,
      enabled: task.enabled,
      kind: task.kind,
      scheduleHint: taskScheduleToHint(task.schedule),
      schedule: toCerebellumTaskSchedule(task.schedule),
      status: task.lastResult ?? 'pending',
      createdAt: task.createdAt,
      lastRunAt: task.lastRunAt,
      lastScheduledSlot: task.lastScheduledSlot,
      schedulerStatus: task.schedulerStatus ?? getDesiredSchedulerStatus(task),
      lastSummary: task.lastSummary,
      metadata: deriveTaskMetadata(task),
    };
  }

  function persistTaskDefinition(task: TaskDefinition): TaskDefinition {
    const saved = taskStore.upsert({
      ...task,
      schedulerStatus: task.schedulerStatus ?? getDesiredSchedulerStatus(task),
    });
    if (saved.activeConversationId) {
      orchestrator.setTaskConversation(saved.id, saved.activeConversationId);
    }
    refreshOrchestratorTaskPrompt();
    return saved;
  }

  async function syncManagedTasksWithCerebellum(
    options: { throwOnError?: boolean; syncContextTaskIds?: string[] } = {},
  ): Promise<boolean> {
    if (!cerebellumClient?.isConnected()) return false;
    const tasks = taskStore.list();
    try {
      await cerebellumClient.syncManagedTasks(
        tasks.filter((task) => shouldSyncTaskWithCerebellum(task)).map(toSupervisorTaskState),
        instanceTimezone,
      );

      for (const task of tasks) {
        const desiredStatus = getDesiredSchedulerStatus(task);
        if (task.schedulerStatus === desiredStatus && !task.schedulerError) continue;
        taskStore.upsert({
          ...task,
          schedulerStatus: desiredStatus,
          schedulerError: undefined,
        });
      }
      refreshOrchestratorTaskPrompt();
      return true;
    } catch (err) {
      const error = (err as Error).message;
      const impactedTaskIds = new Set(options.syncContextTaskIds ?? []);
      for (const task of tasks) {
        if (!impactedTaskIds.has(task.id)) continue;
        const fallbackStatus = task.schedulerStatus === 'running'
          ? 'running'
          : 'pending_cerebellum';
        taskStore.upsert({
          ...task,
          schedulerStatus: fallbackStatus,
          schedulerError: error,
        });
      }
      refreshOrchestratorTaskPrompt();
      if (options.throwOnError !== false) {
        throw err;
      }
      return false;
    }
  }

  function buildSupervisorState(): CerebellumSupervisorState {
    const tasks = taskStore.list();
    const activeTaskIds = tasks
      .filter((task) => task.lastResult === 'running' || orchestrator.isTaskRunning(task.id))
      .map((task) => task.id);
    return {
      timestamp: Math.floor(Date.now() / 1000),
      timezone: instanceTimezone,
      tasks: tasks.map(toSupervisorTaskState),
      activeTaskIds,
      browserAvailable:
        config.tools.browser.enabled
        && (config.tools.browser.mode !== 'extension' || browserRelay?.isExtensionConnected() === true),
      channelsAvailable: channelManager.listConnected().length > 0,
      cerebrumBusy: activeTaskIds.length > 0,
      fineTuneRunning: fineTuneActive,
    };
  }

  async function recordSupervisorIssue(
    task: TaskDefinition,
    action: CerebellumTaskAction,
  ): Promise<void> {
    const alreadyRecordedForSlot = action.slotKey
      && task.lastScheduledSlot === action.slotKey
      && task.lastResult === 'failure';
    if (alreadyRecordedForSlot) return;

    const now = new Date().toISOString();
    const summary = `Cerebellum deferred ${task.id}: ${action.reason}.`;
    const failedTask: TaskDefinition = {
      ...task,
      lastRunAt: now,
      lastScheduledSlot: action.slotKey ?? task.lastScheduledSlot,
      lastResult: 'failure',
      lastSummary: summary,
      updatedAt: now,
      schedulerStatus: 'registered',
      lastSupervisorDecision: action.reason,
      schedulerError: action.reason,
    };
    const runRecordBase: Omit<TaskRunRecord, 'id' | 'taskId'> = {
      status: 'failure',
      scheduledFor: action.scheduledFor,
      slotKey: action.slotKey,
      startedAt: now,
      completedAt: now,
      summary,
      error: action.reason,
      conversationId: failedTask.activeConversationId,
    };
    const reported = await deliverTaskReport(failedTask, {
      id: '',
      taskId: task.id,
      ...runRecordBase,
    }).catch(() => ({ id: '', taskId: task.id, ...runRecordBase }));
    taskStore.appendRun(task.id, {
      ...runRecordBase,
      reportDeliveredAt: reported.reportDeliveredAt,
    });
    persistTaskDefinition(failedTask);
  }

  async function handleSupervisorActions(actions: CerebellumTaskAction[]): Promise<void> {
    let launchedManagedTask = false;
    for (const action of actions) {
      if (!['invoke_task', 'continue_task', 'retry_task', 'report_issue'].includes(action.action)) {
        continue;
      }
      const task = taskStore.get(action.taskId);
      if (!task || !task.enabled) continue;

      if (action.action === 'report_issue') {
        await recordSupervisorIssue(task, action);
        continue;
      }

      if (launchedManagedTask) continue;
      if (orchestrator.isTaskRunning(task.id)) continue;

      launchedManagedTask = true;
      void executeManagedTask(task, {
        scheduledFor: action.scheduledFor,
        slotKey: action.slotKey,
        reason: action.reason,
      });
    }
  }

  for (const task of taskStore.list()) {
    if (task.schedulerStatus) continue;
    taskStore.upsert({
      ...task,
      schedulerStatus: getDesiredSchedulerStatus(task),
    });
  }
  refreshOrchestratorTaskPrompt();

  function getTaskDefinitions(): TaskDefinition[] {
    return taskStore.list().sort((a, b) => a.id.localeCompare(b.id));
  }

  function getTaskRuns(taskId: string): TaskRunRecord[] {
    return taskStore.listRuns(taskId);
  }

  function getTaskState(): Record<string, TaskStateEntry> {
    return Object.fromEntries(
      taskStore.list().map((task) => [
        task.id,
        {
          conversationId: task.activeConversationId ?? '',
          lastRunAt: task.lastRunAt,
          runCount: task.runCount,
        },
      ]),
    );
  }

  function getEnabledTasks(): Array<{ id: string; goal: string; schedule: string; autoMode: boolean; timeoutMinutes: number }> {
    return listActiveTasks().map((task) => ({
      id: task.id,
      goal: task.goal,
      schedule: formatTaskSchedule(task.schedule),
      autoMode: task.autoMode,
      timeoutMinutes: task.timeoutMinutes,
    }));
  }

  function taskListText(tasks: TaskDefinition[]): string {
    if (tasks.length === 0) return 'No active routine tasks.';
    return tasks.map((task) => {
      const nextRun = getNextTaskRun(task.schedule, new Date(), {
        lastRunAt: task.lastRunAt,
        timezone: task.timezone ?? instanceTimezone,
      });
      const status = task.lastResult === 'running' ? 'running' : task.enabled ? 'active' : 'disabled';
      const scheduler = task.schedulerStatus ?? getDesiredSchedulerStatus(task);
      return [
        `${task.id} | ${task.kind} | ${formatTaskSchedule(task.schedule)} | ${status} | scheduler:${scheduler}`,
        `Goal: ${task.goal.split('\n')[0]}`,
        `Next: ${nextRun ? nextRun.toISOString() : 'n/a'}`,
      ].join('\n');
    }).join('\n\n');
  }

  function resolveOriginReportTarget(task: TaskDefinition): {
    channelId: string;
    to: string;
    threadId?: string;
    replyToId?: string;
  } | null {
    const origin = task.origin;
    if (!origin?.channelId) return null;
    const to = origin.routeTo
      ?? origin.threadId
      ?? origin.sessionId?.split(':').slice(1).join(':')
      ?? '';
    if (!to) return null;
    return {
      channelId: origin.channelId,
      to,
      threadId: origin.threadId,
      replyToId: origin.replyToId,
    };
  }

  async function deliverTaskReport(task: TaskDefinition, run: TaskRunRecord): Promise<TaskRunRecord> {
    if (task.reportTarget !== 'origin') return run;
    const target = resolveOriginReportTarget(task);
    if (!target) return run;
    const headline = run.status === 'success'
      ? `Scheduled task "${task.id}" completed.`
      : `Scheduled task "${task.id}" failed.`;
    const body = [
      headline,
      `Goal: ${task.goal.split('\n')[0]}`,
      `Status: ${run.status}`,
      `Summary: ${run.summary}`,
      run.error ? `Error: ${run.error}` : null,
      run.completedAt ? `Completed: ${run.completedAt}` : null,
    ].filter(Boolean).join('\n');
    await channelManager.send(target.channelId, {
      to: target.to,
      text: body,
      threadId: target.threadId,
      replyToId: target.replyToId,
    });
    return { ...run, reportDeliveredAt: new Date().toISOString() };
  }

  async function saveTaskDefinition(task: TaskDefinition): Promise<TaskDefinition> {
    const baseline: TaskDefinition = {
      ...task,
      schedulerStatus: task.schedulerStatus ?? getDesiredSchedulerStatus(task),
      schedulerError:
        cerebellumClient?.isConnected() || !shouldSyncTaskWithCerebellum(task)
          ? task.schedulerError
          : undefined,
    };
    const saved = persistTaskDefinition(baseline);
    if (cerebellumClient?.isConnected()) {
      await syncManagedTasksWithCerebellum({
        throwOnError: false,
        syncContextTaskIds: [saved.id],
      });
      return taskStore.get(saved.id) ?? saved;
    }
    if (shouldSyncTaskWithCerebellum(saved) && saved.schedulerStatus !== 'pending_cerebellum') {
      return persistTaskDefinition({
        ...saved,
        schedulerStatus: 'pending_cerebellum',
      });
    }
    return saved;
  }

  async function removeTaskDefinition(taskId: string): Promise<boolean> {
    const removed = taskStore.remove(taskId);
    refreshOrchestratorTaskPrompt();
    if (removed && cerebellumClient?.isConnected()) {
      await syncManagedTasksWithCerebellum({ throwOnError: false });
    }
    return removed;
  }

  async function upsertTaskFromTool(
    args: Record<string, unknown>,
    context?: { conversationId?: string; ingress?: { channelId?: string; routeTo?: string; senderId?: string; senderName?: string; sessionId?: string; threadId?: string; replyToId?: string; timestamp?: number } },
  ): Promise<{ task: TaskDefinition; created: boolean }> {
    const now = new Date().toISOString();
    const goal = String(args.goal ?? '').trim();
    if (!goal) throw new Error('task_upsert requires a goal.');
    const providedId = args.id ? String(args.id) : goal.split('\n')[0];
    const candidateId = buildNormalizedTaskId(providedId);
    const existingIds = new Set(taskStore.list().map((task) => task.id));
    // Only allow overwriting an existing ID if the caller explicitly provided that ID
    const isExplicitUpdate = Boolean(args.id) && existingIds.has(candidateId);
    const taskId = normalizeTaskId(providedId, {
      reservedIds: existingIds,
      currentId: isExplicitUpdate ? candidateId : undefined,
    });
    const schedule = normalizeTaskSchedule(
      (args.schedule as string | TaskSchedule | undefined) ?? 'daily',
      { defaultTimezone: instanceTimezone, defaultCatchUpPolicy: 'once' },
    );
    const existing = taskStore.get(taskId);
    const reportTarget = (args.reportTarget as TaskReportTarget | undefined)
      ?? (context?.ingress?.channelId ? 'origin' : 'none');
    const task: TaskDefinition = {
      ...(existing ?? {
        id: taskId,
        createdAt: now,
        origin: {
          source: context?.ingress?.channelId ? 'channel' : 'conversation',
          createdAt: now,
          conversationId: context?.conversationId,
          channelId: context?.ingress?.channelId,
          routeTo: context?.ingress?.routeTo,
          senderId: context?.ingress?.senderId,
          senderName: context?.ingress?.senderName,
          sessionId: context?.ingress?.sessionId,
          threadId: context?.ingress?.threadId,
          replyToId: context?.ingress?.replyToId,
        },
      }),
      id: taskId,
      goal,
      enabled: args.enabled === undefined ? existing?.enabled ?? true : Boolean(args.enabled),
      kind: (args.kind as TaskDefinition['kind'] | undefined) ?? existing?.kind ?? (schedule.type === 'one_shot' ? 'one_shot' : 'recurring'),
      schedule,
      autoMode: args.autoMode === undefined ? existing?.autoMode ?? true : Boolean(args.autoMode),
      timeoutMinutes: args.timeoutMinutes === undefined ? existing?.timeoutMinutes ?? 10 : Number(args.timeoutMinutes),
      reportTarget,
      timezone: schedule.type === 'interval' ? undefined : schedule.timezone,
      schedulerStatus: existing?.schedulerStatus
        ?? ((args.enabled === undefined ? existing?.enabled ?? true : Boolean(args.enabled))
          ? 'pending_cerebellum'
          : 'disabled'),
      updatedAt: now,
    };
    if (task.kind === 'one_shot' && !task.activePlanId) {
      const plan = planStore.save({
        taskId,
        goal,
        steps: [{ description: goal.split('\n')[0], status: 'pending' }],
        conversationId: task.activeConversationId,
        status: 'in_progress',
      });
      task.activePlanId = plan.id;
    }
    return { task: await saveTaskDefinition(task), created: !existing };
  }

  const taskManagementParameters = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      goal: { type: 'string' },
      kind: { type: 'string', enum: ['recurring', 'one_shot'] },
      schedule: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['interval', 'daily_at', 'one_shot'] },
              every: { type: 'number' },
              unit: { type: 'string', enum: ['minutes', 'hours', 'days', 'weeks'] },
              time: { type: 'string' },
              dueAt: { type: 'string' },
              timezone: { type: 'string' },
              catchUpPolicy: { type: 'string', enum: ['none', 'once'] },
            },
          },
        ],
      },
      enabled: { type: 'boolean' },
      autoMode: { type: 'boolean' },
      timeoutMinutes: { type: 'number' },
      reportTarget: { type: 'string', enum: ['origin', 'none'] },
    },
    required: ['goal', 'schedule'],
  } as const;

  orchestrator.registerTool('task_upsert', {
    description: 'Create or update a scheduled or one-shot task in the instance task registry.',
    parameters: taskManagementParameters as unknown as Record<string, unknown>,
    execute: async (args, context) => {
      const result = await upsertTaskFromTool(args, {
        conversationId: context?.conversationId,
        ingress: context?.ingress,
      });
      const nextRun = getNextTaskRun(result.task.schedule, new Date(), {
        lastRunAt: result.task.lastRunAt,
        timezone: result.task.timezone ?? instanceTimezone,
      });
      return {
        output:
          `${result.created ? 'Created' : 'Updated'} task ${result.task.id} `
          + `(${formatTaskSchedule(result.task.schedule)}; scheduler=${result.task.schedulerStatus ?? 'unknown'}; `
          + `next=${nextRun ? nextRun.toISOString() : 'n/a'}).`,
        details: { task: result.task, nextRun: nextRun?.toISOString() },
      };
    },
  });

  orchestrator.registerTool('task_list', {
    description: 'List active routine tasks and active long-running one-shot tasks.',
    parameters: { type: 'object', properties: {} } as Record<string, unknown>,
    execute: async () => {
      const tasks = listActiveTasks();
      return {
        output: taskListText(tasks),
        details: { tasks },
      };
    },
  });

  orchestrator.registerTool('task_get', {
    description: 'Get a specific task definition and recent run history.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    } as Record<string, unknown>,
    execute: async (args) => {
      const id = normalizeTaskId(String(args.id ?? ''));
      const task = taskStore.get(id);
      if (!task) {
        return { output: `Task ${id} not found.`, isError: true };
      }
      const runs = taskStore.listRuns(id).slice(-5);
      return {
        output:
          `${task.id}: ${formatTaskSchedule(task.schedule)}\n`
          + `Scheduler: ${task.schedulerStatus ?? getDesiredSchedulerStatus(task)}\n`
          + `${task.goal}`,
        details: { task, runs },
      };
    },
  });

  orchestrator.registerTool('task_remove', {
    description: 'Disable and remove a task from the active task registry.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    } as Record<string, unknown>,
    execute: async (args) => {
      const id = normalizeTaskId(String(args.id ?? ''));
      const removed = await removeTaskDefinition(id);
      return {
        output: removed ? `Removed task ${id}.` : `Task ${id} not found.`,
        isError: !removed,
      };
    },
  });

  // Seed approved users from static allowFrom config
  const channelConfigs = config.channels as Record<string, unknown>;
  for (const [channelId, channelCfg] of Object.entries(channelConfigs)) {
    if (channelId === 'dmPolicy' || typeof channelCfg !== 'object' || !channelCfg) continue;
    const cfg = channelCfg as { allowFrom?: string[] };
    if (cfg.allowFrom) {
      for (const userId of cfg.allowFrom) {
        pairingStore.addConfigUser(channelId, userId);
      }
    }
  }

  // Wire channels to orchestrator
  channelManager.setHandler(async (msg) => {
    try {
      // Check for slash commands from channels
      const parsed = parseCommand(msg.text);
      if (parsed) {
        const cmdCtx: CommandContext = {
          orchestrator, cerebrum, channelManager, skillRegistry, config,
          service: { runTask, getTaskState, getEnabledTasks, getTaskDefinitions, getTaskRuns } as unknown as ServiceInstance,
          currentModel: cerebrum.getDefaultModel(),
          currentProvider: cerebrum.getDefaultProvider(),
          autoMode: orchestrator.getAutoMode(),
        };
        const result = handleSlashCommand(parsed.command, parsed.args, cmdCtx);
        if (result.type === 'message') return result.text;
        if (result.type === 'async') return await result.promise;
        if (result.type === 'tuiOnly') return `/${parsed.command} is only available in the TUI.`;
        return `Unknown command: /${parsed.command}. Type /help for available commands.`;
      }

      // Regular message — send to orchestrator
      const conversationId = getOrCreateChannelConversationId(msg);
      const turnId = randomUUID().replace(/-/g, '').slice(0, 10);
      let proactiveReply = '';
      const unsub = orchestrator.on('message:proactive', ({ content }) => {
        proactiveReply += (proactiveReply ? '\n\n' : '') + content;
      });

      try {
        await orchestrator.sendMessage(msg.text, conversationId, {
          source: 'channel',
          turnId,
          ingress: {
            channelId: msg.channelId,
            routeTo: msg.routeTo,
            senderId: msg.senderId,
            senderName: msg.senderName,
            sessionId: msg.sessionId,
            threadId: msg.threadId,
            replyToId: msg.replyToId,
            timestamp: msg.timestamp,
          },
        });
      } finally {
        unsub();
      }

      const messages = orchestrator.getMessages(conversationId);
      const lastMsg = messages[messages.length - 1];
      const reply = lastMsg?.role === 'cerebrum' ? lastMsg.content : undefined;

      if (reply) {
        orchestrator.recordSessionEvent(
          conversationId,
          turnId,
          'channel_egress',
          `Sent channel reply to ${msg.senderName || msg.senderId || 'unknown recipient'}.`,
          {
            channelId: msg.channelId,
            routeTo: msg.routeTo,
            senderId: msg.senderId,
            senderName: msg.senderName,
            sessionId: msg.sessionId,
            threadId: msg.threadId,
            replyToId: msg.replyToId,
            replyExcerpt: reply.slice(0, 500),
          },
        );
      }

      if (proactiveReply) {
        return reply ? `${reply}\n\n${proactiveReply}` : proactiveReply;
      }
      return reply;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Channel handler error', { error: message });
      return `Error: ${message}`;
    }
  });

  // Wire discovery mode for first run
  if (needsDiscovery) {
    orchestrator.setDiscoveryMode(true);
    orchestrator.setDiscoveryCompleteHandler((result) => {
      // Update instance identity with discovered profile
      instanceStore.updateProfile({
        name: result.name,
        role: result.role,
        traits: result.traits,
        source: 'discovered',
      });
      orchestrator.setProfile(result);
      orchestrator.sendProactiveMessage(
        `Identity saved! I'm ${result.name}, role: ${result.role}. Ready to work.`,
        'discovery-complete',
      );
      log.info('Discovery completed, instance profile updated', { name: result.name });

      // Queue training pairs from the discovery conversation for a later fine-tune round
      try {
        const discoveryPairs: import('@cereworker/hippocampus').TrainingPair[] = [];
        const messages = orchestrator.getMessages();
        const discoverySessionId = orchestrator.getActiveConversationId() ?? undefined;
        for (let i = 0; i < messages.length - 1; i++) {
          if (messages[i].role === 'user' && messages[i + 1].role === 'cerebrum') {
            discoveryPairs.push({
              instruction: messages[i].content,
              response: messages[i + 1].content,
              source: 'discovery',
              createdAt: messages[i + 1].timestamp,
              instanceId: instanceStore.get()?.id,
              sessionId: discoverySessionId,
              exampleClass: 'discovery',
            });
          }
        }
        if (discoveryPairs.length > 0) {
          fineTuneArchive.enqueue('discovery', discoveryPairs);
        }
      } catch {
        // Non-critical
      }
    });
  }

  orchestrator.start();

  // Start browser extension relay if configured
  if (browserRelay) {
    browserRelay.start().then(() => {
      log.info('Browser relay started', { port: config.tools.browser.extension.relayPort });
    }).catch((err) => {
      log.warn('Failed to start browser relay', { error: (err as Error).message });
    });
    browserRelay.on('extension:connected', () => {
      orchestrator.emit({ type: 'browser:extension-connected' });
    });
    browserRelay.on('extension:disconnected', () => {
      orchestrator.emit({ type: 'browser:extension-disconnected' });
    });
  }

  // Expire stale pairing codes every 5 minutes
  const pairingExpiryInterval = setInterval(() => pairingStore.expireStale(), 5 * 60 * 1000);

  // Track handles for cleanup
  let cerebellumClient: CerebellumClient | null = null;
  let cerebellumPoller: ReturnType<typeof setInterval> | null = null;
  let gatewayServer: GatewayServer | null = null;
  let gatewayClient: GatewayNodeClient | null = null;

  function findComposeFile(): string | null {
    // 1. Check config (saved during onboarding)
    if (config.cerebellum.docker.composeFile) {
      const configured = resolve(config.cerebellum.docker.composeFile);
      if (existsSync(configured)) return configured;
    }

    // 2. Walk up from cwd
    const searchUp = (start: string): string | null => {
      let dir = start;
      for (let i = 0; i < 10; i++) {
        const candidate = join(dir, 'docker-compose.yml');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return null;
    };

    const fromCwd = searchUp(process.cwd());
    if (fromCwd) return fromCwd;

    // 3. Walk up from the module's own location (works when cwd differs from project root)
    try {
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const fromModule = searchUp(moduleDir);
      if (fromModule) return fromModule;
    } catch {
      // import.meta.url unavailable in some bundled environments
    }

    return null;
  }

  // Prefix for docker commands — set to 'sudo ' if user lacks permission
  let dockerPrefix = '';

  async function executeManagedTask(
    task: TaskDefinition,
    options: {
      slotKey?: string;
      scheduledFor?: string;
      reason?: string;
      timeoutMs?: number;
      autoMode?: boolean;
    } = {},
  ): Promise<{ success: boolean; error?: string }> {
    const startedAt = new Date().toISOString();
    const runningTask: TaskDefinition = {
      ...task,
      activeConversationId: orchestrator.getTaskConversation(task.id) ?? task.activeConversationId,
      lastRunAt: startedAt,
      lastScheduledSlot: options.slotKey ?? task.lastScheduledSlot,
      lastResult: 'running',
      schedulerStatus: 'running',
      schedulerError: undefined,
      lastSupervisorDecision: options.reason ?? task.lastSupervisorDecision,
      runCount: (task.runCount ?? 0) + 1,
      updatedAt: startedAt,
    };
    await saveTaskDefinition(runningTask);

    const result = await orchestrator.runTask(task.id, task.goal, {
      timeoutMs: options.timeoutMs ?? task.timeoutMinutes * 60_000,
      autoMode: options.autoMode ?? task.autoMode,
    });

    const completedAt = new Date().toISOString();
    const conversationId = orchestrator.getTaskConversation(task.id) ?? runningTask.activeConversationId;
    const finalTask: TaskDefinition = {
      ...runningTask,
      activeConversationId: conversationId,
      lastResult: result.success ? 'success' : 'failure',
      lastSummary: result.success
        ? `Completed task ${task.id}${options.reason ? ` (${options.reason})` : ''}.`
        : (result.error ?? `Task ${task.id} failed.`),
      schedulerStatus: task.kind === 'one_shot' && result.success ? 'disabled' : 'registered',
      schedulerError: result.success ? undefined : result.error,
      updatedAt: completedAt,
      ...(task.kind === 'one_shot' && result.success ? { enabled: false } : {}),
    };

    if (finalTask.activePlanId) {
      planStore.updateStatus(finalTask.activePlanId, result.success ? 'completed' : 'failed');
    }

    const runRecordBase: Omit<TaskRunRecord, 'id' | 'taskId'> = {
      status: result.success ? 'success' : 'failure',
      scheduledFor: options.scheduledFor,
      slotKey: options.slotKey,
      startedAt,
      completedAt,
      summary: finalTask.lastSummary ?? '',
      error: result.success ? undefined : result.error,
      conversationId,
    };

    const reportableRun = await deliverTaskReport(finalTask, {
      id: '',
      taskId: task.id,
      ...runRecordBase,
    }).catch((err) => {
      log.warn('Failed to deliver task report', { taskId: task.id, error: (err as Error).message });
      return { id: '', taskId: task.id, ...runRecordBase };
    });
    taskStore.appendRun(task.id, {
      ...runRecordBase,
      reportDeliveredAt: reportableRun.reportDeliveredAt,
    });

    await saveTaskDefinition(finalTask);

    if (!result.success) {
      log.warn('Managed task failed', { taskId: task.id, error: result.error });
    }
    return result;
  }

  function isDockerAvailable(): boolean {
    // Check if Docker is installed (check PATH, then common locations)
    let dockerBin = '';
    try {
      dockerBin = execSyncImpl('which docker', { stdio: 'pipe' }).toString().trim();
    } catch {
      // Not in PATH — check common install locations
      const candidates = ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker'];
      for (const c of candidates) {
        try {
          execSyncImpl(`test -x ${c}`, { stdio: 'pipe' });
          dockerBin = c;
          break;
        } catch {}
      }
    }

    if (!dockerBin) {
      log.warn('Docker is not installed. Install Docker to use Cerebellum.');
      return false;
    }

    // Try without sudo first
    try {
      execSyncImpl(`${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      // Docker installed but daemon not running
      if (msg.includes('Is the docker daemon running') || msg.includes('Cannot connect to the Docker daemon')) {
        // Try to start the service
        try {
          execSyncImpl('sudo -n systemctl start docker', { stdio: 'pipe', timeout: 15_000 });
          log.info('Started Docker service');
          execSyncImpl(`${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
          return true;
        } catch {
          log.warn('Docker service is not running. Start it with: sudo systemctl start docker');
          return false;
        }
      }

      // Permission denied — try with sudo
      try {
        execSyncImpl(`sudo -n ${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
        dockerPrefix = 'sudo ';
        log.info('Using sudo for Docker commands (add user to docker group to avoid this)');
        return true;
      } catch {
        // Permission denied even with sudo — try to fix docker group membership
        const user = process.env.USER || process.env.LOGNAME;
        if (user) {
          try {
            execSyncImpl(`sudo -n usermod -aG docker ${user}`, { stdio: 'pipe' });
            dockerPrefix = 'sudo ';
            log.info('Added user to docker group. Using sudo for this session — re-login to use Docker without sudo.');
            return true;
          } catch {
            // sudo needs password — can't auto-fix
          }
        }
        log.warn('Docker permission denied. Run: sudo usermod -aG docker $USER && newgrp docker');
        return false;
      }
    }
  }

  function ensureImageExists(): boolean {
    const image = config.cerebellum.docker.image;
    try {
      const exists = execSyncImpl(`${dockerPrefix}docker images -q ${image}`, { stdio: 'pipe' }).toString().trim();
      if (exists) {
        // Image exists — try background pull for updates (non-blocking)
        try {
          const pullCmd = dockerPrefix ? 'sudo' : 'docker';
          const pullArgs = dockerPrefix ? ['docker', 'pull', image] : ['pull', image];
          const child = spawnImpl(pullCmd, pullArgs, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
          child.unref();
          let pullOutput = '';
          child.stdout?.on('data', (data: Buffer) => { pullOutput += data.toString(); });
          child.on('exit', (code) => {
            if (code === 0 && pullOutput.includes('Downloaded newer image')) {
              log.info('Background pull completed — new Cerebellum image available. Restart to use it.');
            }
          });
        } catch {
          // Background pull setup failed — non-critical
        }
        return true;
      }
    } catch {
      return false;
    }

    // Image missing — pull synchronously
    try {
      log.info(`Pulling Cerebellum image ${image} from Docker Hub...`);
      execSyncImpl(`${dockerPrefix}docker pull ${image}`, { stdio: 'pipe', timeout: 3_600_000 });
      log.info('Cerebellum image pulled from Docker Hub');
      return true;
    } catch (err) {
      log.debug('Docker Hub pull failed', { error: (err as Error).message });
    }

    // Fall back to building from compose file (works in source repo checkout)
    const composeFile = findComposeFile();
    if (composeFile) {
      log.info('Building Cerebellum Docker image from source...');
      try {
        execSyncImpl(`${dockerPrefix}docker compose -f "${composeFile}" build cerebellum`, {
          cwd: dirname(composeFile),
          stdio: 'pipe',
          timeout: 600_000,
        });
        log.info('Cerebellum image built');
        return true;
      } catch (err) {
        log.warn('Failed to build Cerebellum image', { error: (err as Error).message });
      }
    }

    log.warn('Cerebellum image not found. Run "cereworker onboard" to build it.');
    return false;
  }

  function ensureDockerRunning(): boolean {
    if (!isDockerAvailable()) return false;
    const resolvedModel = resolveCerebellumDockerModel(config);

    const getConfiguredModelPath = (): string | null => {
      try {
        const envLines = execSyncImpl(
          `${dockerPrefix}docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" cereworker-cerebellum`,
          { stdio: 'pipe' },
        ).toString().trim().split('\n');
        const modelLine = envLines.find((line) => line.startsWith('MODEL_PATH='));
        return modelLine ? modelLine.slice('MODEL_PATH='.length) : null;
      } catch {
        return null;
      }
    };

    // Check if already running
    try {
      const out = execSyncImpl(`${dockerPrefix}docker ps -q -f name=cereworker-cerebellum`, {
        stdio: 'pipe',
      }).toString().trim();
      if (out) {
        log.info('Cerebellum container already running');
        return true;
      }
    } catch {
      return false;
    }

    // Check if container exists but stopped
    try {
      const stopped = execSyncImpl(`${dockerPrefix}docker ps -aq -f name=cereworker-cerebellum`, {
        stdio: 'pipe',
      }).toString().trim();
      if (stopped) {
        const configuredModelPath = getConfiguredModelPath();
        if (configuredModelPath && configuredModelPath !== resolvedModel.modelPath) {
          execSyncImpl(`${dockerPrefix}docker rm -f cereworker-cerebellum`, { stdio: 'pipe' });
          log.info('Removed stale Cerebellum container to refresh model path', {
            previousModelPath: configuredModelPath,
            nextModelPath: resolvedModel.modelPath,
          });
        } else {
          execSyncImpl(`${dockerPrefix}docker start cereworker-cerebellum`, { stdio: 'pipe' });
          log.info('Restarted stopped Cerebellum container');
          return true;
        }
      }
    } catch {
      // Fall through to create
    }

    // Ensure image exists (auto-build on first run)
    if (!ensureImageExists()) return false;

    // Try docker compose
    const composeFile = findComposeFile();
    if (composeFile) {
      try {
        const composeEnv = buildCerebellumComposeEnv(config);
        const command = buildCerebellumComposeCommand(composeFile, composeEnv, Boolean(dockerPrefix));
        execFileSyncImpl(command.command, command.args, {
          ...(command.env ? { env: command.env } : {}),
          stdio: 'pipe',
          cwd: dirname(composeFile),
        });
        log.info('Started Cerebellum via docker compose');
        return true;
      } catch (err) {
        log.warn('docker compose up failed', { error: (err as Error).message });
      }
    }

    // Fall back to docker run
    try {
      const image = config.cerebellum.docker.image;
      const modelId = resolvedModel.modelPath;
      const interval = config.cerebellum.heartbeatInterval;
      const port = config.cerebellum.address.split(':')[1] ?? '50051';

      // Use host models directory if it exists (pre-downloaded during onboarding),
      // otherwise fall back to Docker named volume
      const modelsPath = config.cerebellum.docker.modelsPath.replace(/^~/, homeDir());
      const modelsVolume = existsSync(modelsPath)
        ? `"${modelsPath}":/root/.cache/huggingface`
        : 'cerebellum-models:/root/.cache/huggingface';

      execSyncImpl(
        `${dockerPrefix}docker run -d --name cereworker-cerebellum` +
        ` -p ${port}:50051` +
        ` -e MODEL_PATH=${modelId}` +
        ` -e HEARTBEAT_INTERVAL=${interval}` +
        ` -v ${modelsVolume}` +
        ` -v cerebellum-checkpoints:/checkpoints` +
        ` -v cerebellum-data:/data` +
        ` --restart unless-stopped` +
        ` ${image}`,
        { stdio: 'pipe' },
      );
      log.info('Started Cerebellum via docker run');
      return true;
    } catch (err) {
      log.warn('docker run failed', { error: (err as Error).message });
      return false;
    }
  }

  async function startCerebellum(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!config.cerebellum.enabled) return { ok: false, reason: 'Cerebellum is disabled in config.' };

    // Auto-start Docker container
    let dockerReason = '';
    if (config.cerebellum.docker.autoStart) {
      orchestrator.emit({ type: 'cerebellum:loading', phase: 'Starting Docker...' });
      if (!isDockerAvailable()) {
        // Determine specific reason
        try {
          execSyncImpl('which docker', { stdio: 'pipe' });
          // Docker binary found but daemon not running or permission denied
          try {
            execSyncImpl('docker info', { stdio: 'pipe', timeout: 5000 });
          } catch (e) {
            const msg = (e as Error).message;
            if (msg.includes('Is the docker daemon running') || msg.includes('Cannot connect to the Docker daemon')) {
              dockerReason = 'Docker is installed but the service is not running.\n  Start it with: sudo systemctl start docker';
            } else {
              dockerReason = 'Docker permission denied. Run: sudo usermod -aG docker $USER && newgrp docker';
            }
          }
        } catch {
          dockerReason = 'Docker is not installed. Install Docker: https://docs.docker.com/engine/install/';
        }
        if (!dockerReason) dockerReason = 'Docker is not available. Install Docker or check permissions.';
      } else if (!ensureDockerRunning()) {
        // Gather container logs for diagnostics
        try {
          const logs = execSyncImpl(
            `${dockerPrefix}docker logs --tail 20 cereworker-cerebellum 2>&1`,
            { stdio: 'pipe', timeout: 5000 },
          ).toString().trim();
          dockerReason = `Container failed to start.\nLast logs:\n${logs}`;
        } catch {
          dockerReason = 'Container failed to start. No logs available (container may not exist).';
        }
      }
    }

    // Connect gRPC client with retries
    // First run downloads model weights (~1.2 GB for Qwen3 0.6B) and loads them,
    // which can take 2-5 minutes depending on network and hardware.
    const client = createCerebellumClientImpl(config.cerebellum.address);
    const maxRetries = 60;
    const retryDelay = 5000;
    let lastError = '';
    const resolvedModel = resolveCerebellumDockerModel(config);
    const initialPhase = resolvedModel.usingPrefetchedCache
      ? 'Loading model from local cache...'
      : 'Waiting for model (first run may download weights)...';

    orchestrator.emit({ type: 'cerebellum:loading', phase: initialPhase, attempt: 0, maxAttempts: maxRetries });
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const phase = resolvedModel.usingPrefetchedCache
        ? 'Loading model from local cache...'
        : attempt <= 3
          ? 'Waiting for model (first run may download weights)...'
          : attempt <= 20
            ? 'Downloading model weights...'
            : 'Loading model into memory...';
      orchestrator.emit({ type: 'cerebellum:loading', phase, attempt, maxAttempts: maxRetries });
      try {
        await client.connect();
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (client.isConnected()) {
        log.info('Cerebellum connected', { address: config.cerebellum.address, attempt });
        break;
      }
      if (attempt < maxRetries) {
        log.info('Cerebellum not ready, retrying...', { attempt, maxRetries });
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }

    if (!client.isConnected()) {
      const parts = [`Could not connect to Cerebellum at ${config.cerebellum.address} after ${maxRetries} attempts.`];
      if (lastError) parts.push(`Last error: ${lastError}`);
      if (dockerReason) {
        parts.push(dockerReason);
      } else {
        // Docker started fine but gRPC failed — grab container logs for clues
        try {
          const logs = execSyncImpl(
            `${dockerPrefix}docker logs --tail 20 cereworker-cerebellum 2>&1`,
            { stdio: 'pipe', timeout: 5000 },
          ).toString().trim();
          if (logs) parts.push(`Container logs:\n${logs}`);
        } catch {
          // Container might not exist if autoStart is off
        }
      }
      log.warn('Could not connect to Cerebellum', { address: config.cerebellum.address });
      return { ok: false, reason: parts.join('\n') };
    }

    cerebellumClient = client;

    // Bridge to orchestrator
    orchestrator.setCerebellum(client, {
      enabled: config.cerebellum.verification.enabled,
      timeoutMs: config.cerebellum.verification.timeoutMs,
    });

    // Emit initial status
    try {
      const status = await client.getStatus();
      if (status) {
        orchestrator.emit({ type: 'cerebellum:status', status });
      }
    } catch {
      // Non-blocking
    }

    let supervisorTickInFlight = false;
    let supervisorTickPending = false;

    const registerFineTuneHeartbeat = async () => {
      for (const heartbeatId of Array.from(heartbeatTaskMap.keys())) {
        try {
          await client.unregisterTask(heartbeatId);
        } catch {
          // Best effort during reconnect/re-registration
        }
      }
      heartbeatTaskMap.clear();

      // Fine-tune task
      if (config.cerebellum.finetune?.enabled) {
        try {
          const taskId = await client.registerTask(
            'Fine-tune Cerebellum on curated training data',
            finetuneScheduleHint,
            { type: 'finetune' },
          );
          if (taskId) {
            heartbeatTaskMap.set(taskId, { type: 'finetune' });
            log.info('Fine-tune heartbeat task registered', { taskId, schedule: finetuneScheduleHint });
          }
        } catch (err) {
            log.warn('Failed to register fine-tune task', { error: (err as Error).message });
        }
      }

      if (heartbeatTaskMap.size === 0) return;

      // Subscribe to heartbeat events
      (async () => {
        try {
          for await (const event of client.subscribeHeartbeat(config.cerebellum.heartbeatInterval)) {
            for (const action of event.actions) {
              if (action.action !== 'invoke') continue;
              const mapping = heartbeatTaskMap.get(action.taskId);
              if (!mapping) continue;

              if (mapping.type === 'finetune') {
                log.info('Heartbeat triggered fine-tune');
                orchestrator.triggerFineTune().catch((err) =>
                  log.info('Auto fine-tune deferred', { reason: (err as Error).message }),
                );
              }
            }
            orchestrator.emit({ type: 'heartbeat:tick', actions: event.actions });
          }
        } catch (err) {
          log.warn('Heartbeat subscription ended', { error: (err as Error).message });
        }
      })();
    };

    const runSupervisorTick = async () => {
      if (!cerebellumClient?.isConnected()) return;
      if (supervisorTickInFlight) {
        supervisorTickPending = true;
        return;
      }
      supervisorTickInFlight = true;
      try {
        do {
          supervisorTickPending = false;
          const status = await cerebellumClient.getStatus();
          if (status) {
            orchestrator.emit({ type: 'cerebellum:status', status });
          }
          await syncManagedTasksWithCerebellum();
          const actions = await cerebellumClient.reportSupervisorState(buildSupervisorState());
          if (actions.length > 0) {
            log.info('Cerebellum supervisor produced actions', {
              actions: actions.map((action) => ({
                taskId: action.taskId,
                action: action.action,
                reason: action.reason,
              })),
            });
          }
          orchestrator.emit({ type: 'heartbeat:tick', actions });
          await handleSupervisorActions(actions);
        } while (supervisorTickPending && cerebellumClient?.isConnected());
      } finally {
        supervisorTickInFlight = false;
      }
    };

    try {
      await syncManagedTasksWithCerebellum();
      await registerFineTuneHeartbeat();
      await runSupervisorTick();
    } catch (err) {
      log.warn('Failed to initialize Cerebellum supervisor loop', {
        error: (err as Error).message,
      });
    }

    // Start status polling
    const pollInterval = config.cerebellum.heartbeatInterval * 1000;
    cerebellumPoller = setInterval(async () => {
      if (!cerebellumClient) return;
      try {
        await runSupervisorTick();
      } catch {
        // Connection lost — emit offline status
        orchestrator.emit({
          type: 'cerebellum:status',
          status: { healthy: false, modelName: '', uptimeSeconds: 0, tasksRegistered: 0 },
        });

        // Attempt reconnect
        try {
          await cerebellumClient.connect();
          await syncManagedTasksWithCerebellum();
          await registerFineTuneHeartbeat();
          await runSupervisorTick();
        } catch {
          // Will retry next poll
        }
      }
    }, pollInterval);

    return { ok: true };
  }

  async function startChannels(): Promise<number> {
    const channels = channelManager.list();
    if (channels.length > 0) {
      await channelManager.startAll();
      return channelManager.listConnected().length;
    }
    return 0;
  }

  async function startGateway(callbacks?: GatewayCallbacks): Promise<GatewayHandles> {
    const mode = config.gateway.mode;

    if (mode === 'gateway') {
      const server = new GatewayServer({
        port: config.gateway.port,
        token: config.gateway.token,
        invokeTimeoutMs: config.gateway.invokeTimeoutMs,
        pingIntervalMs: config.gateway.pingIntervalMs,
        stateDir: join(dataDir, 'gateway'),
        instanceId,
      });

      server.setNodeConnectedHandler((nodeId, capabilities) => {
        const proxyTools = createProxyTools(server, nodeId, capabilities);
        orchestrator.registerTools(proxyTools);
        orchestrator.emit({ type: 'node:connected', nodeId, capabilities });
        const nodeCount = server.listNodes().length;
        orchestrator.setGatewayMode('gateway', { connectedNodes: nodeCount });
        callbacks?.onNodeConnected?.(nodeId, nodeCount);
      });

      server.setNodeDisconnectedHandler((nodeId, reason, capabilities) => {
        for (const cap of capabilities) {
          orchestrator.unregisterTool(`${cap}@${nodeId}`);
        }
        orchestrator.emit({ type: 'node:disconnected', nodeId, reason });
        const remainingNodes = server.listNodes().length;
        orchestrator.setGatewayMode('gateway', { connectedNodes: remainingNodes });
        callbacks?.onNodeDisconnected?.(nodeId, remainingNodes);
      });

      server.setEnvelopeHandler((nodeId: string, frame: AnyGatewayFrame) => {
        if (!frame.conversationId || !frame.sessionId) return;

        if (frame.eventType === 'tool.started') {
          orchestrator.recordSessionEvent(
            frame.conversationId,
            frame.sessionId,
            'node_tool_started',
            `Node ${nodeId} started ${frame.payload.tool}.`,
            {
              nodeId,
              invocationId: frame.payload.invocationId,
              tool: frame.payload.tool,
              args: frame.payload.args,
              context: frame.payload.context,
            },
          );
          orchestrator.emit({
            type: 'node:invoke',
            nodeId,
            tool: frame.payload.tool,
            id: frame.payload.invocationId,
          });
          return;
        }

        if (frame.eventType === 'tool.finished') {
          orchestrator.recordSessionEvent(
            frame.conversationId,
            frame.sessionId,
            'node_tool_finished',
            `Node ${nodeId} finished ${frame.payload.tool}.`,
            {
              nodeId,
              invocationId: frame.payload.invocationId,
              tool: frame.payload.tool,
              args: frame.payload.args,
              result: frame.payload.result,
              context: frame.payload.context,
            },
          );
          orchestrator.emit({
            type: 'node:invoke-result',
            nodeId,
            id: frame.payload.invocationId,
            isError: frame.payload.result.isError,
          });
          return;
        }

        if (frame.eventType === 'node.status') {
          orchestrator.recordSessionEvent(
            frame.conversationId,
            frame.sessionId,
            'node_status',
            `Node ${nodeId} reported status ${frame.payload.status.healthy ? 'healthy' : 'unhealthy'}.`,
            {
              nodeId,
              requestId: frame.payload.requestId,
              status: frame.payload.status,
            },
          );
        }
      });

      orchestrator.setGatewayMode('gateway', { connectedNodes: 0 });
      await server.start();
      gatewayServer = server;
      log.info('Gateway server started', { port: config.gateway.port });
      return { server, client: null };
    }

    if (mode === 'node') {
      if (!config.gateway.gatewayUrl || !config.gateway.nodeId) {
        log.error('Node mode requires gatewayUrl and nodeId in config');
        return { server: null, client: null };
      }

      const client = new GatewayNodeClient(
        {
          gatewayUrl: config.gateway.gatewayUrl,
          nodeId: config.gateway.nodeId,
          token: config.gateway.token ?? '',
          capabilities: config.gateway.capabilities,
          stateDir: join(dataDir, 'gateway'),
          instanceId,
        },
        async (
          tool: string,
          args: Record<string, unknown>,
          context?: RemoteToolExecutionContext,
        ) => {
          const execution = await orchestrator.executeTool(tool, args, {
            conversationId: context?.conversationId,
            sessionKey: context?.sessionId ?? context?.turnId ?? `gateway:node:${config.gateway.nodeId}`,
            scopeKey: context?.scopeKey ?? context?.conversationId ?? `gateway:node:${config.gateway.nodeId}`,
            callId: context?.callId,
            turnId: context?.turnId,
            attempt: context?.attempt,
          });
          return execution.result;
        },
      );

      client.setEmergencyStopHandler(() => {
        orchestrator.emergencyStop();
      });

      orchestrator.setGatewayMode('node', { gatewayUrl: config.gateway.gatewayUrl });

      try {
        await client.connect();
        gatewayClient = client;
        log.info('Connected to gateway', { url: config.gateway.gatewayUrl });
      } catch (err) {
        log.error('Failed to connect to gateway', { error: (err as Error).message });
      }
      return { server: null, client };
    }

    // standalone
    return { server: null, client: null };
  }

  // --- Proactive Controller ---
  let proactiveController: ProactiveController | null = null;
  if (config.proactive.enabled) {
    proactiveController = new ProactiveController({
      planStore,
      instanceStore,
      output: {
        sendToUser: (content, source) => {
          orchestrator.sendProactiveMessage(content, source);
        },
        broadcastToChannels: async (content) => {
          try { await channelManager.broadcast({ to: 'all', text: content }); } catch { /* best effort */ }
        },
      },
      taskRunner: {
        runTask: (taskId, goal, options) => orchestrator.runTask(taskId, goal, options),
        isTaskRunning: (taskId) => orchestrator.isTaskRunning(taskId),
      },
      textGenerator: {
        generate: (prompt) => cerebrum.generate(prompt),
      },
      config: {
        enabled: config.proactive.enabled,
        resumeOnBoot: config.proactive.resumeOnBoot,
        statusReports: config.proactive.statusReports,
        statusReportSchedule: config.proactive.statusReportSchedule,
        maxConcurrentProactive: config.proactive.maxConcurrentProactive,
      },
    });

    orchestrator.setProactiveEnabled(true);
    log.info('Proactive controller initialized', {
      resumeOnBoot: config.proactive.resumeOnBoot,
      statusReports: config.proactive.statusReports,
    });
  }

  async function shutdown(): Promise<void> {
    // Persist running agent state before shutdown for recovery on restart
    orchestrator.getSubAgentManager()?.persistAllRunning();
    proactiveController?.stop();
    if (cerebellumPoller) {
      clearInterval(cerebellumPoller);
      cerebellumPoller = null;
    }
    if (cerebellumClient) {
      await cerebellumClient.disconnect();
      cerebellumClient = null;
    }
    if (gatewayServer) {
      await gatewayServer.stop();
      gatewayServer = null;
    }
    if (gatewayClient) {
      gatewayClient.disconnect();
      gatewayClient = null;
    }
    if (browserRelay) {
      await browserRelay.stop();
      browserRelay = null;
    }
    clearInterval(pairingExpiryInterval);
    pairingStore.close();
    channelManager.stopAll();
    orchestrator.stop();
    log.info('Service shut down');
  }

  async function runTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    const task = taskStore.get(normalizeTaskId(taskId));
    if (!task) return { success: false, error: `Unknown task: ${taskId}` };
    return executeManagedTask(task, { reason: 'manual' });
  }

  async function listHeartbeatTasks(): Promise<Array<{ taskId: string; description: string; status: string; lastRun?: number; scheduleHint: string; metadata?: Record<string, string> }>> {
    if (!cerebellumClient) return [];
    return cerebellumClient.listTasks();
  }

  return {
    orchestrator,
    channelManager,
    cerebrum,
    skillRegistry,
    pairingStore,
    instanceStore,
    proactiveController,
    needsDiscovery,
    startChannels,
    startCerebellum,
    startGateway,
    runTask,
    getTaskState,
    getTaskDefinitions,
    getTaskRuns,
    getEnabledTasks,
    listHeartbeatTasks,
    shutdown,
  };
}
