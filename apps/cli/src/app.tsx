import React, { useMemo, useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { configureLogger } from '@cereworker/core';
import type { CereWorkerConfig } from '@cereworker/config';
import { GatewayServer, GatewayNodeClient } from '@cereworker/gateway';
import { createService } from './service.js';
import { StatusBar } from './components/StatusBar.js';
import { ChatView } from './components/ChatView.js';
import { InputBar } from './components/InputBar.js';
import { useChat } from './hooks/useChat.js';
import { useCerebellum } from './hooks/useCerebellum.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../package.json');

interface AppProps {
  config: CereWorkerConfig;
  resumeConversationId?: string;
}

export function App({ config, resumeConversationId }: AppProps) {
  const { exit } = useApp();
  const [channelCount, setChannelCount] = useState(0);
  const [systemMessage, setSystemMessage] = useState<string | null>(null);
  const [stickyMessage, setStickyMessage] = useState(false);
  const [currentProvider, setCurrentProvider] = useState(config.cerebrum.defaultProvider);
  const [currentModel, setCurrentModel] = useState(config.cerebrum.defaultModel);
  const [autoMode, setAutoMode] = useState(config.tools.shell.autoMode);
  const [gatewayNodeCount, setGatewayNodeCount] = useState(0);
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [gatewayServer, setGatewayServer] = useState<GatewayServer | null>(null);
  const [gatewayClient, setGatewayClient] = useState<GatewayNodeClient | null>(null);

  const service = useMemo(() => {
    configureLogger({
      level: config.logging.level as 'debug' | 'info' | 'warn' | 'error',
      file: config.logging.file,
    });
    return createService(config);
  }, [config]);
  const { orchestrator, channelManager, cerebrum, skillRegistry } = service;

  // Start channels in background
  useEffect(() => {
    service.startChannels().then(setChannelCount);
    return () => {
      channelManager.stopAll();
    };
  }, [service]);

  // Start cerebellum in background
  useEffect(() => {
    if (config.cerebellum.enabled) {
      service.startCerebellum().then((result) => {
        if (!result.ok) {
          setStickyMessage(true);
          setSystemMessage(
            'Cerebellum failed to start. This is a core feature — tool verification and scheduling are unavailable.\n\n' +
            result.reason +
            '\n\n  Re-run onboarding: cereworker onboard',
          );
        }
      });
    }
  }, [service]);

  // Start gateway/node mode
  useEffect(() => {
    if (config.gateway.mode === 'standalone') return;

    service.startGateway({
      onNodeConnected: (_id, count) => setGatewayNodeCount(count),
      onNodeDisconnected: (_id, count) => setGatewayNodeCount(count),
    }).then(({ server, client }) => {
      setGatewayServer(server);
      setGatewayClient(client);
    });

    return () => {
      service.shutdown();
    };
  }, [service]);

  // Resume conversation from --resume flag
  useEffect(() => {
    if (!resumeConversationId) return;
    const store = orchestrator.getConversationStore();
    const convs = store.list();
    const match = convs.find((c) => c.id.startsWith(resumeConversationId));
    if (match) {
      orchestrator.resumeConversation(match.id);
    } else {
      setSystemMessage(`No conversation found starting with "${resumeConversationId}"`);
    }
  }, [orchestrator, resumeConversationId]);

  // Listen for browser extension events
  useEffect(() => {
    const unsub1 = orchestrator.on('browser:extension-connected', () => setExtensionConnected(true));
    const unsub2 = orchestrator.on('browser:extension-disconnected', () => setExtensionConnected(false));
    return () => { unsub1(); unsub2(); };
  }, [orchestrator]);

  const { messages, isStreaming, streamingContent, activeToolCall, error } = useChat(orchestrator);
  const { status: cerebellumStatus, loading: cerebellumLoadingInfo, finetune, taskRunningCount } = useCerebellum(orchestrator);

  const handleSubmit = useCallback(
    (text: string) => {
      setStickyMessage(false);
      setSystemMessage(null);
      orchestrator.sendMessage(text);
    },
    [orchestrator],
  );

  const handleCommand = useCallback(
    (command: string, args: string) => {
      // Clear any sticky system message from previous command
      setStickyMessage(false);

      switch (command) {
        case 'quit':
        case 'exit':
          exit();
          service.shutdown().finally(() => process.exit(0));
          break;

        case 'clear':
          orchestrator.startConversation();
          break;

        case 'channels': {
          const connected = channelManager.listConnected();
          const all = channelManager.list();
          const info = all.map((ch) => `  ${ch.meta.emoji} ${ch.meta.name}: ${ch.isConnected() ? 'connected' : 'offline'}`).join('\n');
          setSystemMessage(`Channels (${connected.length}/${all.length} connected):\n${info || '  (none registered)'}`);
          break;
        }

        case 'model':
          if (args.trim()) {
            cerebrum.setModel(args.trim());
            setCurrentModel(args.trim());
            setSystemMessage(`Model switched to: ${args.trim()}`);
          } else {
            setSystemMessage(`Current model: ${currentModel}`);
          }
          break;

        case 'provider':
          if (args.trim()) {
            cerebrum.setProvider(args.trim());
            setCurrentProvider(args.trim());
            setSystemMessage(`Provider switched to: ${args.trim()}`);
          } else {
            setSystemMessage(`Current provider: ${currentProvider}`);
          }
          break;

        case 'agents': {
          const mgr = orchestrator.getSubAgentManager();
          if (!mgr) {
            setSystemMessage('Sub-agents are not enabled.');
            break;
          }
          const summary = mgr.getSummary();
          const agents = mgr.listAgents();
          const lines = [
            `Agents: ${summary.total} total, ${summary.running} running, ${summary.completed} completed, ${summary.failed} failed`,
          ];
          for (const a of agents.slice(0, 10)) {
            const elapsed = Math.round((Date.now() - a.spawnedAt) / 1000);
            lines.push(`  [${a.status}] ${a.label ?? a.id} - ${a.task.slice(0, 60)} (${elapsed}s)`);
          }
          setSystemMessage(lines.join('\n'));
          break;
        }

        case 'memory': {
          const memPath = join(
            config.hippocampus.directory.replace('~', homedir()),
            'MEMORY.md',
          );
          try {
            if (existsSync(memPath)) {
              const content = readFileSync(memPath, 'utf-8');
              setSystemMessage(`--- MEMORY.md ---\n${content.slice(0, 2000)}`);
            } else {
              setSystemMessage('No MEMORY.md found.');
            }
          } catch {
            setSystemMessage('Failed to read MEMORY.md');
          }
          break;
        }

        case 'skills': {
          const skills = skillRegistry.list();
          if (skills.length === 0) {
            setSystemMessage('No skills loaded.');
          } else {
            const lines = skills.map((s) => {
              const emoji = s.metadata?.cereworker?.emoji ?? '';
              return `  ${emoji} ${s.name} - ${s.description}`;
            });
            setSystemMessage(`Loaded skills (${skills.length}):\n${lines.join('\n')}`);
          }
          break;
        }

        case 'config': {
          const lines = [
            `Provider: ${currentProvider}`,
            `Model: ${currentModel}`,
            `Temperature: ${config.cerebrum.temperature}`,
            `Max steps: ${config.cerebrum.maxSteps}`,
            `Cerebellum: ${config.cerebellum.enabled ? 'enabled' : 'disabled'}`,
            `Hippocampus: ${config.hippocampus.enabled ? config.hippocampus.directory : 'disabled'}`,
            `Sub-agents: ${config.subAgents.enabled ? `max ${config.subAgents.maxConcurrent}` : 'disabled'}`,
            `Logging: ${config.logging.level}${config.logging.file ? ` -> ${config.logging.file}` : ''}`,
          ];
          setSystemMessage(`Configuration:\n${lines.map((l) => `  ${l}`).join('\n')}`);
          break;
        }

        case 'conversations': {
          const store = orchestrator.getConversationStore();
          const convs = store.list().slice(0, 20);
          if (convs.length === 0) {
            setStickyMessage(false);
            setSystemMessage('No conversations found.');
          } else {
            const activeId = orchestrator.getActiveConversationId();
            const lines = convs.map((c) => {
              const date = new Date(c.updatedAt).toLocaleString();
              const preview = store.getPreview(c.id)?.slice(0, 50) ?? '(empty)';
              const marker = c.id === activeId ? ' *' : '';
              return `  ${c.id.slice(0, 8)}${marker} | ${date} | ${preview}`;
            });
            setStickyMessage(true);
            setSystemMessage(`Conversations (${convs.length}):\n${lines.join('\n')}`);
          }
          break;
        }

        case 'resume': {
          const targetId = args.trim();
          if (!targetId) {
            const store = orchestrator.getConversationStore();
            const convs = store.list().slice(0, 20);
            if (convs.length === 0) {
              setStickyMessage(false);
              setSystemMessage('No conversations to resume.');
            } else {
              const activeId = orchestrator.getActiveConversationId();
              const lines = convs.map((c) => {
                const date = new Date(c.updatedAt).toLocaleString();
                const preview = store.getPreview(c.id)?.slice(0, 50) ?? '(empty)';
                const marker = c.id === activeId ? ' *' : '';
                return `  ${c.id.slice(0, 8)}${marker} | ${date} | ${preview}`;
              });
              setStickyMessage(true);
              setSystemMessage(`Pick a conversation to resume with /resume <id>:\n${lines.join('\n')}`);
            }
            break;
          }
          // Support partial IDs
          const store = orchestrator.getConversationStore();
          const convs = store.list();
          const match = convs.find((c) => c.id.startsWith(targetId));
          if (!match) {
            setSystemMessage(`No conversation found starting with "${targetId}"`);
            break;
          }
          if (orchestrator.resumeConversation(match.id)) {
            setSystemMessage(`Resumed conversation ${match.id.slice(0, 8)} (${store.getMessages(match.id).length} messages)`);
          } else {
            setSystemMessage(`Failed to resume conversation ${targetId}`);
          }
          break;
        }

        case 'auto': {
          const arg = args.trim().toLowerCase();
          if (arg === 'on') {
            setAutoMode(true);
            orchestrator.setAutoMode(true);
            setSystemMessage('Auto mode ENABLED. Commands execute without approval. Cerebellum pre-screens destructive operations.');
          } else if (arg === 'off') {
            setAutoMode(false);
            orchestrator.setAutoMode(false);
            setSystemMessage('Auto mode DISABLED. Unknown commands require approval.');
          } else {
            setSystemMessage(`Auto mode: ${autoMode ? 'ON' : 'OFF'}. Usage: /auto [on|off]`);
          }
          break;
        }

        case 'nodes': {
          const gwMode = config.gateway.mode;
          if (gwMode === 'gateway' && gatewayServer) {
            const nodes = gatewayServer.listNodes();
            if (nodes.length === 0) {
              setSystemMessage('No nodes connected.');
            } else {
              const lines = nodes.map((n) => {
                const elapsed = Math.round((Date.now() - n.connectedAt) / 1000);
                return `  ${n.nodeId} (${n.status}, ${n.capabilities.length} tools, ${elapsed}s)`;
              });
              setSystemMessage(`Connected nodes (${nodes.length}):\n${lines.join('\n')}`);
            }
          } else if (gwMode === 'node' && gatewayClient) {
            setSystemMessage(`Node mode: ${gatewayClient.isConnected() ? 'connected' : 'disconnected'} to ${config.gateway.gatewayUrl}`);
          } else {
            setSystemMessage('Gateway not active. Set gateway.mode in config to "gateway" or "node".');
          }
          break;
        }

        case 'auth': {
          const authProvider = args.trim() || 'openai';
          setSystemMessage(`Run 'cereworker auth ${authProvider}' from your terminal to authenticate via OAuth.`);
          break;
        }

        case 'finetune': {
          const ftArgs = args.trim().split(/\s+/);
          const ftSub = ftArgs[0] || '';

          if (ftSub === 'start') {
            orchestrator.triggerFineTune()
              .then(() => setSystemMessage('Fine-tuning started.'))
              .catch((err: Error) => setSystemMessage(`Fine-tune error: ${err.message}`));
          } else if (ftSub === 'status' || ftSub === '') {
            orchestrator.getFineTuneStatus().then((st) => {
              const lines = [
                `Status: ${st.status}`,
                st.jobId ? `Job: ${st.jobId}` : null,
                st.status === 'running' ? `Progress: ${Math.round(st.progress * 100)}% (step ${st.currentStep}/${st.totalSteps})` : null,
                st.currentLoss ? `Loss: ${st.currentLoss.toFixed(4)}` : null,
                st.checkpointPath ? `Checkpoint: ${st.checkpointPath}` : null,
                st.error ? `Error: ${st.error}` : null,
                st.startedAt ? `Started: ${new Date(st.startedAt * 1000).toLocaleString()}` : null,
                st.completedAt && st.status !== 'running' ? `Completed: ${new Date(st.completedAt * 1000).toLocaleString()}` : null,
              ].filter(Boolean);
              setSystemMessage(`Fine-Tuning Status:\n  ${lines.join('\n  ')}`);
            }).catch((err: Error) => setSystemMessage(`Fine-tune status error: ${err.message}`));
          } else if (ftSub === 'config') {
            const configKey = ftArgs[1] || '';
            const configVal = ftArgs[2] || '';

            if (configKey === 'method' && configVal) {
              const valid = ['auto', 'lora', 'qlora', 'full'];
              if (valid.includes(configVal)) {
                orchestrator.setFineTuneMethod(configVal);
                setSystemMessage(`Fine-tune method set to: ${configVal}`);
              } else {
                setSystemMessage(`Invalid method. Valid: ${valid.join(', ')}`);
              }
            } else if (configKey === 'schedule' && configVal) {
              const valid = ['auto', 'hourly', 'daily', 'weekly'];
              if (valid.includes(configVal)) {
                orchestrator.setFineTuneSchedule(configVal);
                setSystemMessage(`Fine-tune schedule set to: ${configVal}`);
              } else {
                setSystemMessage(`Invalid schedule. Valid: ${valid.join(', ')}`);
              }
            } else {
              setSystemMessage(
                `Fine-Tune Config:\n` +
                `  Method: ${orchestrator.getFineTuneMethod()}\n` +
                `  Schedule: ${orchestrator.getFineTuneSchedule()}\n` +
                `  Enabled: ${config.cerebellum.finetune?.enabled ?? false}\n\n` +
                `Usage:\n` +
                `  /finetune config method <auto|lora|qlora|full>\n` +
                `  /finetune config schedule <auto|hourly|daily|weekly>`,
              );
            }
          } else if (ftSub === 'history') {
            const history = orchestrator.getFineTuneHistory();
            if (history.length === 0) {
              setSystemMessage('No fine-tune history yet.');
            } else {
              const lines = history.slice(-10).map((h) => {
                const date = new Date(h.completedAt).toLocaleString();
                return `  ${h.jobId} | ${h.status} | loss: ${h.loss.toFixed(4)} | ${date}`;
              });
              setStickyMessage(true);
              setSystemMessage(`Fine-Tune History (last ${lines.length}):\n${lines.join('\n')}`);
            }
          } else {
            setSystemMessage(
              'Usage: /finetune [start|status|config|history]\n' +
              '  /finetune           Show current status\n' +
              '  /finetune start     Start a fine-tune run\n' +
              '  /finetune status    Detailed status info\n' +
              '  /finetune config    Show/change config\n' +
              '  /finetune history   Show past jobs',
            );
          }
          break;
        }

        case 'task': {
          const taskArgs = args.trim().split(/\s+/);
          const taskSub = taskArgs[0] || '';
          const taskTarget = taskArgs[1] || '';

          if (taskSub === 'run' && taskTarget) {
            setSystemMessage(`Running task "${taskTarget}"...`);
            service.runTask(taskTarget).then((result) => {
              if (result.success) {
                setSystemMessage(`Task "${taskTarget}" completed.`);
              } else {
                setSystemMessage(`Task "${taskTarget}" failed: ${result.error}`);
              }
            });
          } else if (taskSub === 'history' && taskTarget) {
            const convId = orchestrator.getTaskConversation(taskTarget);
            if (!convId) {
              setSystemMessage(`No conversation history for task "${taskTarget}".`);
            } else {
              const messages = orchestrator.getMessages(convId);
              if (messages.length === 0) {
                setSystemMessage(`Task "${taskTarget}" has an empty conversation.`);
              } else {
                const lines = messages.slice(-10).map((m) => {
                  const prefix = m.role === 'user' ? '[GOAL]' : '[AGENT]';
                  const text = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
                  return `  ${prefix} ${text}`;
                });
                setStickyMessage(true);
                setSystemMessage(`Task "${taskTarget}" — last ${lines.length} messages:\n${lines.join('\n')}`);
              }
            }
          } else if (taskSub === '' || taskSub === 'list') {
            const tasks = service.getEnabledTasks();
            if (tasks.length === 0) {
              setSystemMessage('No recurring tasks configured. Add tasks to your cereworker.yml config.');
            } else {
              const state = service.getTaskState();
              const lines = tasks.map((t) => {
                const s = state[t.id];
                const running = orchestrator.isTaskRunning(t.id) ? ' [RUNNING]' : '';
                const lastRun = s?.lastRunAt ? ` (last: ${new Date(s.lastRunAt).toLocaleString()}, runs: ${s.runCount ?? 0})` : ' (never run)';
                return `  ${t.id} (${t.schedule})${running}${lastRun}\n    ${t.goal.split('\n')[0]}`;
              });
              setStickyMessage(true);
              setSystemMessage(`Recurring Tasks:\n${lines.join('\n')}`);
            }
          } else {
            setSystemMessage(
              'Usage: /task [list|run|history]\n' +
              '  /task              List configured tasks\n' +
              '  /task run <id>     Manually trigger a task\n' +
              '  /task history <id> Show recent messages from a task',
            );
          }
          break;
        }

        case 'stop':
          orchestrator.emergencyStop();
          gatewayServer?.emergencyStopAll();
          setSystemMessage('Emergency stop triggered. All operations aborted.');
          break;

        case 'approve': {
          if (!args.trim()) {
            setSystemMessage('Usage: /approve <CODE>');
            break;
          }
          const result = service.pairingStore.approveCode(args.trim());
          if (result.ok) {
            const name = result.senderName ?? result.senderId;
            setSystemMessage(`Approved: ${name} on ${result.channelId}`);
          } else {
            setSystemMessage(`Failed: ${result.error}`);
          }
          break;
        }

        case 'pairing': {
          service.pairingStore.expireStale();
          const pending = service.pairingStore.listPending();
          if (pending.length === 0) {
            setSystemMessage('No pending pairing requests.');
          } else {
            const lines = pending.map((req) => {
              const name = req.senderName ?? req.senderId;
              const ttl = Math.round((req.expiresAt - Date.now()) / 60000);
              const code = `${req.code.slice(0, 4)}-${req.code.slice(4)}`;
              return `  ${code}  ${req.channelId}  ${name}  expires in ${ttl}m`;
            });
            setStickyMessage(true);
            setSystemMessage(`Pending pairing requests:\n${lines.join('\n')}\n\nApprove with: /approve <CODE>`);
          }
          break;
        }

        case 'help':
          setSystemMessage(
            `Available commands:
  /model [name]         Show or switch the current model
  /provider [name]      Show or switch the current provider
  /agents               Show sub-agent summary
  /memory               Show MEMORY.md contents
  /skills               List loaded skills
  /config               Show current configuration
  /conversations        List past conversations
  /resume <id>          Resume a past conversation
  /channels             Show channel status
  /nodes                Show connected nodes (gateway/node mode)
  /approve <code>       Approve a channel pairing request
  /pairing              List pending pairing requests
  /auto [on|off]        Toggle auto mode (skip command approval)
  /auth [provider]      OAuth authentication instructions
  /finetune [sub]       Fine-tuning: start, status, config, history
  /task [sub]           Recurring tasks: list, run <id>, history <id>
  /stop                 Emergency stop (works during streaming)
  /clear                Start a new conversation
  /help                 Show this help
  /quit                 Exit CereWorker`,
          );
          break;

        default:
          setSystemMessage(`Unknown command: /${command}. Type /help for available commands.`);
          break;
      }
    },
    [service, orchestrator, channelManager, cerebrum, skillRegistry, exit, config, currentModel, currentProvider, autoMode, gatewayServer, gatewayClient],
  );

  // Clear system message after a delay (skip sticky messages like /resume lists)
  useEffect(() => {
    if (!systemMessage || stickyMessage) return;
    const timer = setTimeout(() => setSystemMessage(null), 15_000);
    return () => clearTimeout(timer);
  }, [systemMessage, stickyMessage]);

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar
        provider={currentProvider}
        model={currentModel}
        cerebellumStatus={cerebellumStatus}
        cerebellumLoading={cerebellumLoadingInfo}
        cerebellumEnabled={config.cerebellum.enabled}
        isStreaming={isStreaming}
        channelCount={channelCount}
        autoMode={autoMode}
        gatewayMode={config.gateway.mode}
        gatewayNodeCount={gatewayNodeCount}
        gatewayConnected={gatewayClient?.isConnected() ?? false}
        gatewayUrl={config.gateway.gatewayUrl}
        finetuneActive={finetune.active}
        finetuneProgress={finetune.progress}
        dmPolicy={config.channels.dmPolicy}
        taskCount={service.getEnabledTasks().length}
        taskRunning={taskRunningCount}
        extensionConnected={extensionConnected}
      />
      <ChatView
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        activeToolCall={activeToolCall}
        version={APP_VERSION}
      />
      {systemMessage && (
        <Box paddingX={1} borderStyle="single" borderColor="gray">
          <Text color="gray">{systemMessage}</Text>
        </Box>
      )}
      {error && (
        <Box paddingX={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
      <InputBar
        onSubmit={handleSubmit}
        onCommand={handleCommand}
        disabled={isStreaming}
      />
    </Box>
  );
}
