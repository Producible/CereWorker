import { execFileSync, execSync, spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, ConversationStore, PairingStore, InstanceStore, PlanStore, ProactiveController, createLogger, createHttpTools } from '@cereworker/core';
import { CerebellumClient } from '@cereworker/cerebellum-client';
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
  createMemoryTools,
  memoryReadParameters,
  memoryWriteParameters,
  memoryLogParameters,
  memorySearchParameters,
} from '@cereworker/hippocampus';
import { GatewayServer, GatewayNodeClient, createProxyTools } from '@cereworker/gateway';
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
  const createCerebrumImpl = deps.createCerebrum
    ?? ((providerConfig, options) => new CerebrumProvider(providerConfig, options));
  const createChannelManagerImpl = deps.createChannelManager ?? createChannelManager;
  const createCerebellumClientImpl = deps.createCerebellumClient
    ?? ((address: string) => new CerebellumClient(address));

  // Create persistent conversation store
  const conversationStore = new ConversationStore();

  // Instance identity
  const instanceStore = new InstanceStore();
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
  const skillDirs = [
    ...config.skills.directories,
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

  // Set recurring tasks so system prompt includes them
  const enabledTasks = config.tasks.filter((t) => t.enabled);
  if (enabledTasks.length > 0) {
    orchestrator.setRecurringTasks(enabledTasks.map((t) => ({ id: t.id, goal: t.goal, schedule: t.schedule })));
    log.info('Recurring tasks configured', { count: enabledTasks.length });
  }

  // Load persisted task state (conversationId mappings)
  const taskStateFile = join(homeDir(), '.cereworker', 'task-state.json');
  type TaskState = Record<string, { conversationId: string; lastRunAt?: string; runCount?: number }>;
  let taskState: TaskState = {};
  try {
    if (existsSync(taskStateFile)) {
      taskState = JSON.parse(readFileSync(taskStateFile, 'utf-8'));
      for (const [taskId, state] of Object.entries(taskState)) {
        if (state.conversationId) {
          orchestrator.setTaskConversation(taskId, state.conversationId);
        }
      }
      log.info('Task state restored', { tasks: Object.keys(taskState).length });
    }
  } catch {
    log.debug('No task state to restore');
  }

  function saveTaskState(): void {
    try {
      mkdirSync(dirname(taskStateFile), { recursive: true });
      writeFileSync(taskStateFile, JSON.stringify(taskState, null, 2));
    } catch (err) {
      log.warn('Failed to save task state', { error: (err as Error).message });
    }
  }

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

  if (config.cerebellum.finetune?.enabled) {
    const conversationExtractor = new ConversationExtractor(conversationStore);

    // Memory-based curator (requires hippocampus)
    const curator = config.hippocampus.enabled
      ? new HippocampusCurator(
          hippocampusStore!,
          { generate: (prompt: string) => cerebrum.generate(prompt) },
        )
      : null;

    orchestrator.setFineTuneDataProvider(async () => {
      // Source 1: Curated memories
      let memoryPairs: import('@cereworker/hippocampus').TrainingPair[] = [];
      if (curator) {
        await curator.curate();
        memoryPairs = curator.getPendingPairs();
        if (memoryPairs.length > 0) {
          curator.markConsumed();
        }
      }

      // Source 2: Conversation history
      const convPairs = conversationExtractor.extractPairs();

      return [...memoryPairs, ...convPairs];
    }, config.cerebellum.finetune.method);

    orchestrator.setFineTuneSchedule(config.cerebellum.finetune.schedule);
    log.info('Fine-tune data provider configured', { schedule: finetuneScheduleHint });
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
  const pairingStore = new PairingStore();
  channelManager.setDmPolicy(config.channels.dmPolicy);
  channelManager.setPairingProvider(pairingStore);

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
          service: { runTask, getTaskState, getEnabledTasks } as unknown as ServiceInstance,
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
      let proactiveReply = '';
      const unsub = orchestrator.on('message:proactive', ({ content }) => {
        proactiveReply += (proactiveReply ? '\n\n' : '') + content;
      });

      await orchestrator.sendMessage(msg.text, conversationId);

      unsub();

      const messages = orchestrator.getMessages(conversationId);
      const lastMsg = messages[messages.length - 1];
      const reply = lastMsg?.role === 'cerebrum' ? lastMsg.content : undefined;

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

      // Write training pairs from the discovery conversation to pending.jsonl
      try {
        const pendingPath = join(homeDir(), '.cereworker', 'finetune', 'pending.jsonl');
        mkdirSync(dirname(pendingPath), { recursive: true });
        const messages = orchestrator.getMessages();
        for (let i = 0; i < messages.length - 1; i++) {
          if (messages[i].role === 'user' && messages[i + 1].role === 'cerebrum') {
            const pair = JSON.stringify({
              instruction: messages[i].content,
              response: messages[i + 1].content,
              source: 'discovery',
              createdAt: messages[i + 1].timestamp,
            });
            appendFileSync(pendingPath, pair + '\n', 'utf-8');
          }
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

    // Register heartbeat tasks: fine-tuning + recurring tasks
    const heartbeatTaskMap = new Map<string, { type: 'finetune' } | { type: 'recurring'; configId: string }>();

    const registerHeartbeatTasks = async () => {
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

      // Recurring tasks from config
      for (const task of enabledTasks) {
        const scheduleHint = task.schedule === 'daily' ? 'every day'
          : task.schedule === 'hourly' ? 'every hour'
          : task.schedule === 'weekly' ? 'every week'
          : task.schedule;
        try {
          const taskId = await client.registerTask(
            task.goal.split('\n')[0],
            scheduleHint,
            { type: 'recurring-task', configId: task.id },
          );
          if (taskId) {
            heartbeatTaskMap.set(taskId, { type: 'recurring', configId: task.id });
            log.info('Recurring task registered with heartbeat', { taskId, configId: task.id, schedule: scheduleHint });
          }
        } catch (err) {
          log.warn('Failed to register recurring task', { error: (err as Error).message, taskId: task.id });
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
              } else if (mapping.type === 'recurring') {
                const taskConfig = enabledTasks.find((t) => t.id === mapping.configId);
                if (!taskConfig) continue;
                log.info('Heartbeat triggered recurring task', { taskId: mapping.configId });
                orchestrator.runTask(mapping.configId, taskConfig.goal, {
                  timeoutMs: taskConfig.timeoutMinutes * 60_000,
                  autoMode: taskConfig.autoMode,
                }).then((result) => {
                  // Persist task state after each run
                  const convId = orchestrator.getTaskConversation(mapping.configId);
                  taskState[mapping.configId] = {
                    conversationId: convId ?? '',
                    lastRunAt: new Date().toISOString(),
                    runCount: (taskState[mapping.configId]?.runCount ?? 0) + 1,
                  };
                  saveTaskState();
                  if (!result.success) {
                    log.warn('Recurring task failed', { taskId: mapping.configId, error: result.error });
                  }
                });
              }
            }
            orchestrator.emit({ type: 'heartbeat:tick', actions: event.actions });
          }
        } catch (err) {
          log.warn('Heartbeat subscription ended', { error: (err as Error).message });
        }
      })();
    };

    registerHeartbeatTasks().catch((err) => {
      log.warn('Failed to register heartbeat tasks', { error: (err as Error).message });
    });

    // Start status polling
    const pollInterval = config.cerebellum.heartbeatInterval * 1000;
    cerebellumPoller = setInterval(async () => {
      if (!cerebellumClient) return;
      try {
        const status = await cerebellumClient.getStatus();
        if (status) {
          orchestrator.emit({ type: 'cerebellum:status', status });
        }
      } catch {
        // Connection lost — emit offline status
        orchestrator.emit({
          type: 'cerebellum:status',
          status: { healthy: false, modelName: '', uptimeSeconds: 0, tasksRegistered: 0 },
        });

        // Attempt reconnect
        try {
          await cerebellumClient.connect();
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
        },
        async (tool, args) => {
          const execution = await orchestrator.executeTool(tool, args, {
            sessionKey: `gateway:node:${config.gateway.nodeId}`,
            scopeKey: `gateway:node:${config.gateway.nodeId}`,
          });
          return execution.result.output;
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
    const planStore = new PlanStore();

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
    const taskConfig = enabledTasks.find((t) => t.id === taskId);
    if (!taskConfig) return { success: false, error: `Unknown task: ${taskId}` };

    const result = await orchestrator.runTask(taskId, taskConfig.goal, {
      timeoutMs: taskConfig.timeoutMinutes * 60_000,
      autoMode: taskConfig.autoMode,
    });

    // Persist state
    const convId = orchestrator.getTaskConversation(taskId);
    taskState[taskId] = {
      conversationId: convId ?? '',
      lastRunAt: new Date().toISOString(),
      runCount: (taskState[taskId]?.runCount ?? 0) + 1,
    };
    saveTaskState();

    return result;
  }

  function getTaskState(): Record<string, TaskStateEntry> {
    return { ...taskState };
  }

  function getEnabledTasks(): Array<{ id: string; goal: string; schedule: string; autoMode: boolean; timeoutMinutes: number }> {
    return enabledTasks;
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
    getEnabledTasks,
    listHeartbeatTasks,
    shutdown,
  };
}
