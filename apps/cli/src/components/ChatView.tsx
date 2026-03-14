import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '@cereworker/core';
import { Banner } from './Banner.js';

interface ChatViewProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  activeToolCall: string | null;
  version: string;
}

function MessageBlock({ message }: { message: Message }) {
  const roleColors: Record<string, string> = {
    user: 'blue',
    cerebrum: 'green',
    tool: 'yellow',
    system: 'gray',
    cerebellum: 'magenta',
  };

  const roleLabels: Record<string, string> = {
    user: 'You',
    cerebrum: 'Cerebrum',
    tool: 'Tool',
    system: 'System',
    cerebellum: 'Cerebellum',
  };

  const color = roleColors[message.role] ?? 'white';
  const label = roleLabels[message.role] ?? message.role;

  if (message.role === 'tool') {
    const output = message.content.length > 500
      ? message.content.slice(0, 500) + '\n... (truncated)'
      : message.content;
    return (
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <Text color="yellow" dimColor>
          Tool: {message.toolResult?.callId ?? 'unknown'}
          {message.toolResult?.isError ? ' (error)' : ''}
        </Text>
        <Text dimColor>{output}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>{label}</Text>
      <Text>{message.content}</Text>
    </Box>
  );
}

export function ChatView({ messages, streamingContent, isStreaming, activeToolCall, version }: ChatViewProps) {
  const showBanner = messages.length === 0 && !isStreaming;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {showBanner && <Banner version={version} />}
      {messages.map((msg) => (
        <MessageBlock key={msg.id} message={msg} />
      ))}
      {activeToolCall && (
        <Box marginLeft={2}>
          <Text color="yellow">Running tool: {activeToolCall}...</Text>
        </Box>
      )}
      {isStreaming && streamingContent && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Cerebrum</Text>
          <Text>{streamingContent}<Text color="green">|</Text></Text>
        </Box>
      )}
      {isStreaming && !streamingContent && !activeToolCall && (
        <Box>
          <Text color="gray">Thinking...</Text>
        </Box>
      )}
    </Box>
  );
}
