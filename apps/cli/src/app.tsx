import React, { useMemo, useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { configureLogger } from '@cereworker/core';
import type { CereWorkerConfig } from '@cereworker/config';
import { GatewayServer, GatewayNodeClient } from '@cereworker/gateway';
import { createService } from './service.js';
import { StatusBar } from './components/StatusBar.js';
import { ChatView } from './components/ChatView.js';
import { InputBar } from './components/InputBar.js';
import { useChat } from './hooks/useChat.js';
import { useCerebellum } from './hooks/useCerebellum.js';

interface AppProps {
  config: CereWorkerConfig;
}

export function App({ config }: AppProps) {
  const { exit } = useApp();
  const [channelCount, setChannelCount] = useState(0);
  const [systemMessage, setSystemMessage] = useState<string | null>(null);
  const [currentProvider, setCurrentProvider] = useState(config.cerebrum.defaultProvider);
  const [currentModel, setCurrentModel] = useState(config.cerebrum.defaultModel);
  const [autoMode, setAutoMode] = useState(config.tools.shell.autoMode);
  const [gatewayNodeCount, setGatewayNodeCount] = useState(0);
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
      service.startCerebellum();
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

  const { messages, isStreaming, streamingContent, activeToolCall, error } = useChat(orchestrator);
  const { status: cerebellumStatus, finetune } = useCerebellum(orchestrator);

  const handleSubmit = useCallback(
    (text: string) => {
      orchestrator.sendMessage(text);
    },
    [orchestrator],
  );

  const handleCommand = useCallback(
    (command: string, args: string) => {
      switch (command) {
        case 'quit':
        case 'exit':
          orchestrator.stop();
          channelManager.stopAll();
          exit();
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
            setSystemMessage('No conversations found.');
          } else {
            const activeId = orchestrator.getActiveConversationId();
            const lines = convs.map((c) => {
              const date = new Date(c.updatedAt).toLocaleString();
              const preview = store.getPreview(c.id)?.slice(0, 50) ?? '(empty)';
              const marker = c.id === activeId ? ' *' : '';
              return `  ${c.id.slice(0, 8)}${marker} | ${date} | ${preview}`;
            });
            setSystemMessage(`Conversations (${convs.length}):\n${lines.join('\n')}`);
          }
          break;
        }

        case 'resume': {
          const targetId = args.trim();
          if (!targetId) {
            setSystemMessage('Usage: /resume <conversation-id>');
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

        case 'finetune':
          orchestrator.triggerFineTune()
            .then(() => setSystemMessage('Fine-tuning started.'))
            .catch((err: Error) => setSystemMessage(`Fine-tune error: ${err.message}`));
          break;

        case 'stop':
          orchestrator.emergencyStop();
          gatewayServer?.emergencyStopAll();
          setSystemMessage('Emergency stop triggered. All operations aborted.');
          break;

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
  /auto [on|off]        Toggle auto mode (skip command approval)
  /auth [provider]      OAuth authentication instructions
  /finetune             Manually trigger fine-tuning
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
    [orchestrator, channelManager, cerebrum, skillRegistry, exit, config, currentModel, currentProvider, autoMode, gatewayServer, gatewayClient],
  );

  // Clear system message after a delay
  useEffect(() => {
    if (!systemMessage) return;
    const timer = setTimeout(() => setSystemMessage(null), 15_000);
    return () => clearTimeout(timer);
  }, [systemMessage]);

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar
        provider={currentProvider}
        model={currentModel}
        cerebellumStatus={cerebellumStatus}
        isStreaming={isStreaming}
        channelCount={channelCount}
        autoMode={autoMode}
        gatewayMode={config.gateway.mode}
        gatewayNodeCount={gatewayNodeCount}
        gatewayConnected={gatewayClient?.isConnected() ?? false}
        gatewayUrl={config.gateway.gatewayUrl}
        finetuneActive={finetune.active}
        finetuneProgress={finetune.progress}
      />
      <ChatView
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        activeToolCall={activeToolCall}
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
