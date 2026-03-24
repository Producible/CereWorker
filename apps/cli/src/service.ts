import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, ConversationStore, PairingStore, createLogger, createHttpTools } from '@cereworker/core';
import { CerebellumClient } from '@cereworker/cerebellum-client';
import type { ToolDefinition } from '@cereworker/core';
import { CerebrumProvider } from '@cereworker/cerebrum';
import type { CereWorkerConfig } from '@cereworker/config';
import { createChannelManager, type ChannelManager } from '@cereworker/channels';
import { browserToolDefinitions } from '@cereworker/browser';
import { loadSkills, filterEligibleSkills, SkillRegistry } from '@cereworker/skills';
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

const log = createLogger('service');

export interface GatewayCallbacks {
  onNodeConnected?: (nodeId: string, nodeCount: number) => void;
  onNodeDisconnected?: (nodeId: string, nodeCount: number) => void;
}

export interface GatewayHandles {
  server: GatewayServer | null;
  client: GatewayNodeClient | null;
}

export interface ServiceInstance {
  orchestrator: Orchestrator;
  channelManager: ChannelManager;
  cerebrum: CerebrumProvider;
  skillRegistry: SkillRegistry;
  pairingStore: PairingStore;
  startChannels(): Promise<number>;
  startCerebellum(): Promise<{ ok: true } | { ok: false; reason: string }>;
  startGateway(callbacks?: GatewayCallbacks): Promise<GatewayHandles>;
  shutdown(): Promise<void>;
}

export function createService(config: CereWorkerConfig): ServiceInstance {
  // Create persistent conversation store
  const conversationStore = new ConversationStore();

  const orchestrator = new Orchestrator({
    conversationStore,
    compaction: {
      enabled: config.cerebrum.compaction.enabled,
      threshold: config.cerebrum.compaction.threshold,
      keepRecentMessages: config.cerebrum.compaction.keepRecentMessages,
      contextWindow: config.cerebrum.contextWindow,
    },
  });

  const cerebrumConfig = {
    defaultProvider: config.cerebrum.defaultProvider,
    defaultModel: config.cerebrum.defaultModel,
    providers: config.cerebrum.providers as Record<string, { apiKey?: string; baseUrl?: string; model?: string }>,
    maxSteps: config.cerebrum.maxSteps,
    temperature: config.cerebrum.temperature,
  };

  const cerebrum = new CerebrumProvider(cerebrumConfig, {
    denyList: config.tools.shell.denyList,
    timeout: config.tools.shell.timeout,
    maxOutputSize: config.tools.shell.maxOutputSize,
    autoMode: config.tools.shell.autoMode,
  });

  // Set initial auto mode on orchestrator
  orchestrator.setAutoMode(config.tools.shell.autoMode);

  // Set worker profile
  orchestrator.setProfile(config.profile);

  // Bridge CerebrumProvider to Orchestrator's CerebrumAdapter interface
  orchestrator.setCerebrum({
    stream: async (messages, tools, callbacks) => {
      await cerebrum.stream(messages, tools, callbacks);
    },
    summarize: async (messages) => {
      return cerebrum.summarize(messages);
    },
  });

  // Load and inject skills
  const skillRegistry = new SkillRegistry();
  const skillDirs = [
    ...config.skills.directories,
    join(homedir(), '.cereworker', 'skills'),
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
  for (const [name, toolDef] of Object.entries(browserToolDefinitions)) {
    orchestrator.registerTool(name, {
      description: toolDef.description,
      parameters: toolDef.parameters as unknown as Record<string, unknown>,
      execute: async (args) => toolDef.execute(args as never),
    });
  }

  // Create channel manager
  const channelManager = createChannelManager(config);

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
    await orchestrator.sendMessage(msg.text);
    const messages = orchestrator.getMessages();
    const lastMsg = messages[messages.length - 1];
    return lastMsg?.role === 'cerebrum' ? lastMsg.content : undefined;
  });

  orchestrator.start();

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
      dockerBin = execSync('which docker', { stdio: 'pipe' }).toString().trim();
    } catch {
      // Not in PATH — check common install locations
      const candidates = ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker'];
      for (const c of candidates) {
        try {
          execSync(`test -x ${c}`, { stdio: 'pipe' });
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
      execSync(`${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      // Docker installed but daemon not running
      if (msg.includes('Is the docker daemon running') || msg.includes('Cannot connect to the Docker daemon')) {
        // Try to start the service
        try {
          execSync('sudo -n systemctl start docker', { stdio: 'pipe', timeout: 15_000 });
          log.info('Started Docker service');
          execSync(`${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
          return true;
        } catch {
          log.warn('Docker service is not running. Start it with: sudo systemctl start docker');
          return false;
        }
      }

      // Permission denied — try with sudo
      try {
        execSync(`sudo -n ${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
        dockerPrefix = 'sudo ';
        log.info('Using sudo for Docker commands (add user to docker group to avoid this)');
        return true;
      } catch {
        // Permission denied even with sudo — try to fix docker group membership
        const user = process.env.USER || process.env.LOGNAME;
        if (user) {
          try {
            execSync(`sudo -n usermod -aG docker ${user}`, { stdio: 'pipe' });
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
      const exists = execSync(`${dockerPrefix}docker images -q ${image}`, { stdio: 'pipe' }).toString().trim();
      if (exists) return true;
    } catch {
      return false;
    }

    // Try pulling from Docker Hub
    try {
      log.info('Pulling Cerebellum image from Docker Hub...');
      execSync(`${dockerPrefix}docker pull cereworker/cerebellum:latest`, { stdio: 'pipe', timeout: 3_600_000 });
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
        execSync(`${dockerPrefix}docker compose -f "${composeFile}" build cerebellum`, {
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

    // Check if already running
    try {
      const out = execSync(`${dockerPrefix}docker ps -q -f name=cereworker-cerebellum`, {
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
      const stopped = execSync(`${dockerPrefix}docker ps -aq -f name=cereworker-cerebellum`, {
        stdio: 'pipe',
      }).toString().trim();
      if (stopped) {
        execSync(`${dockerPrefix}docker start cereworker-cerebellum`, { stdio: 'pipe' });
        log.info('Restarted stopped Cerebellum container');
        return true;
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
        const modelId = config.cerebellum.model.id;
        const env = { ...process.env, MODEL_PATH: modelId };
        execSync(`${dockerPrefix}docker compose -f "${composeFile}" up -d cerebellum`, {
          env,
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
      const modelId = config.cerebellum.model.id;
      const interval = config.cerebellum.heartbeatInterval;
      const port = config.cerebellum.address.split(':')[1] ?? '50051';
      execSync(
        `${dockerPrefix}docker run -d --name cereworker-cerebellum` +
        ` -p ${port}:50051` +
        ` -e MODEL_PATH=${modelId}` +
        ` -e HEARTBEAT_INTERVAL=${interval}` +
        ` -v cerebellum-models:/root/.cache/huggingface` +
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
      if (!isDockerAvailable()) {
        // Determine specific reason
        try {
          execSync('which docker', { stdio: 'pipe' });
          // Docker binary found but daemon not running or permission denied
          try {
            execSync('docker info', { stdio: 'pipe', timeout: 5000 });
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
          const logs = execSync(
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
    // Model loading can take 30s+ on first run (downloading weights from HuggingFace)
    const client = new CerebellumClient(config.cerebellum.address);
    const maxRetries = 15;
    const retryDelay = 3000;
    let lastError = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
      if (dockerReason) parts.push(dockerReason);
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

    // Register fine-tune heartbeat task for automatic scheduling
    if (config.cerebellum.finetune?.enabled) {
      const scheduleHint = finetuneScheduleHint;
      client.registerTask(
        'Fine-tune Cerebellum on curated training data',
        scheduleHint,
        { type: 'finetune' },
      ).then((taskId) => {
        if (!taskId) return;
        log.info('Fine-tune heartbeat task registered', { taskId, schedule: scheduleHint });

        // Subscribe to heartbeat events and auto-trigger fine-tuning
        (async () => {
          try {
            for await (const event of client.subscribeHeartbeat(config.cerebellum.heartbeatInterval)) {
              for (const action of event.actions) {
                if (action.taskId === taskId && action.action === 'invoke') {
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
      }).catch((err) => {
        log.warn('Failed to register fine-tune task', { error: (err as Error).message });
      });
    }

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
          const toolDef = (orchestrator as unknown as { tools: Map<string, ToolDefinition> }).tools.get(tool);
          if (!toolDef) throw new Error(`Unknown tool: ${tool}`);
          return toolDef.execute(args);
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

  async function shutdown(): Promise<void> {
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
    clearInterval(pairingExpiryInterval);
    pairingStore.close();
    channelManager.stopAll();
    orchestrator.stop();
    log.info('Service shut down');
  }

  return {
    orchestrator,
    channelManager,
    cerebrum,
    skillRegistry,
    pairingStore,
    startChannels,
    startCerebellum,
    startGateway,
    shutdown,
  };
}
