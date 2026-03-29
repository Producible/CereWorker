import React, { useMemo, useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { createRequire } from 'node:module';
import { configureLogger } from '@cereworker/core';
import type { CereWorkerConfig } from '@cereworker/config';
import { GatewayServer, GatewayNodeClient } from '@cereworker/gateway';
import { createService } from './service.js';
import { handleSlashCommand, type CommandContext } from './commands.js';
import { StatusBar } from './components/StatusBar.js';
import { ChatView } from './components/ChatView.js';
import { InputBar } from './components/InputBar.js';
import { useChat } from './hooks/useChat.js';
import { useCerebellum } from './hooks/useCerebellum.js';
import { checkForUpdate } from './update-check.js';

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
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);

  useEffect(() => {
    void checkForUpdate(APP_VERSION).then((v) => { if (v) setUpdateAvailable(v); });
  }, []);

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

  // Auto-kickoff discovery on first run
  useEffect(() => {
    if (!service.needsDiscovery) return;
    // Send a seed message to trigger the agent's first discovery question
    orchestrator.sendMessage('Hello! I just started for the first time.').catch(() => {});
  }, [service, orchestrator]);

  // Listen for browser extension events
  useEffect(() => {
    const unsub1 = orchestrator.on('browser:extension-connected', () => setExtensionConnected(true));
    const unsub2 = orchestrator.on('browser:extension-disconnected', () => setExtensionConnected(false));
    return () => { unsub1(); unsub2(); };
  }, [orchestrator]);

  const { messages, isStreaming, streamingContent, activeToolCall, error } = useChat(orchestrator);
  const { status: cerebellumStatus, loading: cerebellumLoadingInfo, finetune, taskRunningCount } = useCerebellum(orchestrator);
  const visibleMessages = useMemo(() => {
    const filtered = config.tui.showActivity
      ? messages
      : messages.filter((message) => message.role !== 'tool');
    return filtered.slice(-config.tui.maxDisplayMessages);
  }, [config.tui.maxDisplayMessages, config.tui.showActivity, messages]);

  const handleSubmit = useCallback(
    (text: string) => {
      setStickyMessage(false);
      setSystemMessage(null);
      orchestrator.sendMessage(text).catch((err) => {
        orchestrator.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      });
    },
    [orchestrator],
  );

  const handleCommand = useCallback(
    (command: string, args: string) => {
      setStickyMessage(false);

      // TUI-only commands handled here
      switch (command) {
        case 'quit':
        case 'exit':
          exit();
          service.shutdown().finally(() => process.exit(0));
          return;
        case 'clear':
          orchestrator.startConversation();
          return;
        case 'resume': {
          const targetId = args.trim();
          if (!targetId) {
            const store = orchestrator.getConversationStore();
            const convs = store.list().slice(0, 20);
            if (convs.length === 0) {
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
            return;
          }
          const store = orchestrator.getConversationStore();
          const convs = store.list();
          const match = convs.find((c) => c.id.startsWith(targetId));
          if (!match) { setSystemMessage(`No conversation found starting with "${targetId}"`); return; }
          if (orchestrator.resumeConversation(match.id)) {
            setSystemMessage(`Resumed conversation ${match.id.slice(0, 8)} (${store.getMessages(match.id).length} messages)`);
          } else {
            setSystemMessage(`Failed to resume conversation ${targetId}`);
          }
          return;
        }
        case 'approve': {
          if (!args.trim()) { setSystemMessage('Usage: /approve <CODE>'); return; }
          const result = service.pairingStore.approveCode(args.trim());
          if (result.ok) {
            setSystemMessage(`Approved: ${result.senderName ?? result.senderId} on ${result.channelId}`);
          } else {
            setSystemMessage(`Failed: ${result.error}`);
          }
          return;
        }
        case 'pairing': {
          service.pairingStore.expireStale();
          const pending = service.pairingStore.listPending();
          if (pending.length === 0) { setSystemMessage('No pending pairing requests.'); return; }
          const lines = pending.map((req) => {
            const name = req.senderName ?? req.senderId;
            const ttl = Math.round((req.expiresAt - Date.now()) / 60000);
            const code = `${req.code.slice(0, 4)}-${req.code.slice(4)}`;
            return `  ${code}  ${req.channelId}  ${name}  expires in ${ttl}m`;
          });
          setStickyMessage(true);
          setSystemMessage(`Pending pairing requests:\n${lines.join('\n')}\n\nApprove with: /approve <CODE>`);
          return;
        }
        case 'auth': {
          const authProvider = args.trim() || 'openai-codex';
          setSystemMessage(`Run 'cereworker auth ${authProvider}' from your terminal to authenticate via OAuth.`);
          return;
        }
      }

      // Shared commands — delegate to shared handler
      const cmdCtx: CommandContext = {
        orchestrator, cerebrum, channelManager, skillRegistry, config, service,
        gatewayServer, gatewayClient,
        currentModel, currentProvider, autoMode,
      };
      const result = handleSlashCommand(command, args, cmdCtx);

      switch (result.type) {
        case 'message':
          if (result.sticky) setStickyMessage(true);
          setSystemMessage(result.text);
          // Sync TUI state for model/provider/auto changes
          if (command === 'model' && args.trim()) setCurrentModel(args.trim());
          if (command === 'provider' && args.trim()) setCurrentProvider(args.trim());
          if (command === 'auto') {
            const a = args.trim().toLowerCase();
            if (a === 'on') setAutoMode(true);
            if (a === 'off') setAutoMode(false);
          }
          break;
        case 'async':
          result.promise.then((text) => setSystemMessage(text));
          break;
        case 'unknown':
          setSystemMessage(`Unknown command: /${command}. Type /help for available commands.`);
          break;
        default:
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
        showActivity={config.tui.showActivity}
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
        messages={visibleMessages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        activeToolCall={config.tui.showActivity ? activeToolCall : null}
        version={APP_VERSION}
        showActivity={config.tui.showActivity}
        updateAvailable={updateAvailable}
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
