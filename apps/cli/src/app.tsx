import React, { useMemo, useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { Orchestrator } from '@cereworker/core';
import { CerebrumProvider } from '@cereworker/cerebrum';
import type { CereWorkerConfig } from '@cereworker/config';
import { createChannelManager, type ChannelManager } from '@cereworker/channels';
import { browserToolDefinitions } from '@cereworker/browser';
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

  const { orchestrator, channelManager } = useMemo(() => {
    const orch = new Orchestrator();

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
    });

    // Bridge CerebrumProvider to Orchestrator's CerebrumAdapter interface
    orch.setCerebrum({
      stream: async (messages, _tools, callbacks) => {
        await cerebrum.stream(messages, callbacks);
      },
    });

    // Register browser tools with orchestrator
    for (const [name, toolDef] of Object.entries(browserToolDefinitions)) {
      orch.registerTool(name, {
        description: toolDef.description,
        parameters: {},
        execute: async (args) => toolDef.execute(args as never),
      });
    }

    // Create channel manager
    const chMgr = createChannelManager(config);

    // Wire channels to orchestrator
    chMgr.setHandler(async (msg) => {
      // Send inbound channel message through the orchestrator
      // For now, return a placeholder - full integration would route through cerebrum
      await orch.sendMessage(msg.text);
      const messages = orch.getMessages();
      const lastMsg = messages[messages.length - 1];
      return lastMsg?.role === 'cerebrum' ? lastMsg.content : undefined;
    });

    orch.start();
    return { orchestrator: orch, channelManager: chMgr };
  }, [config]);

  // Start channels in background
  useEffect(() => {
    const channels = channelManager.list();
    if (channels.length > 0) {
      channelManager.startAll().then(() => {
        setChannelCount(channelManager.listConnected().length);
      });
    }

    return () => {
      channelManager.stopAll();
    };
  }, [channelManager]);

  const { messages, isStreaming, streamingContent, activeToolCall, error } = useChat(orchestrator);
  const { status: cerebellumStatus } = useCerebellum(orchestrator);

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
        case 'channels':
          // Display connected channels
          break;
        default:
          break;
      }
    },
    [orchestrator, channelManager, exit],
  );

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar
        provider={config.cerebrum.defaultProvider}
        model={config.cerebrum.defaultModel}
        cerebellumStatus={cerebellumStatus}
        isStreaming={isStreaming}
        channelCount={channelCount}
      />
      <ChatView
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        activeToolCall={activeToolCall}
      />
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
