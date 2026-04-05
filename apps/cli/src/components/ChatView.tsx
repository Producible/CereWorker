import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '@cereworker/core';
import { Banner } from './Banner.js';
import { formatChatTimestamp } from '../presentation.js';

interface ChatViewProps {
  messages: Message[];
  hasAnyMessages: boolean;
  streamingContent: string;
  isStreaming: boolean;
  activeToolCall: string | null;
  version: string;
  debugMode: boolean;
  updateAvailable?: string | null;
}

function MessageBlock({ message, debugMode }: { message: Message; debugMode: boolean }) {
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

  if (!debugMode) {
    const showTimestamp = message.role === 'user' || message.role === 'cerebrum';
    return (
      <Box flexDirection="column" marginBottom={1}>
        {showTimestamp && (
          <Text dimColor>{formatChatTimestamp(message.timestamp)}</Text>
        )}
        <Text color={message.role === 'user' ? 'blue' : 'green'}>{message.content}</Text>
      </Box>
    );
  }

  if (message.role === 'tool') {
    const stringify = (value: unknown, maxChars = 1200): string => {
      const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
      return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... (truncated)` : raw;
    };
    const toolName = String(message.metadata?.toolName ?? 'unknown');
    const requestedToolName = typeof message.metadata?.requestedToolName === 'string'
      ? message.metadata.requestedToolName
      : null;
    const toolArgs = message.metadata?.toolArgs;
    const details = message.toolResult?.details;
    const resume = message.toolResult?.metadata && typeof message.toolResult.metadata === 'object'
      ? message.toolResult.metadata.resume
      : undefined;
    const output = stringify(message.content, 1500);
    return (
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <Text color="yellow" dimColor>
          Tool: {toolName}
          {requestedToolName ? ` (requested as ${requestedToolName})` : ''}
          {' '}
          [{message.toolResult?.callId ?? 'unknown'}]
          {message.toolResult?.isError ? ' (error)' : ''}
        </Text>
        {Boolean(toolArgs) && <Text dimColor>{`Args:\n${stringify(toolArgs)}`}</Text>}
        {Boolean(details) && <Text dimColor>{`Details:\n${stringify(details)}`}</Text>}
        {resume !== undefined && <Text dimColor>{`Resume:\n${stringify(resume)}`}</Text>}
        <Text dimColor>{`Output:\n${output}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text bold color={color}>{label}</Text>
        <Text dimColor>{formatChatTimestamp(message.timestamp)}</Text>
      </Box>
      <Text>{message.content}</Text>
    </Box>
  );
}

export function ChatView({
  messages,
  hasAnyMessages,
  streamingContent,
  isStreaming,
  activeToolCall,
  version,
  debugMode,
  updateAvailable,
}: ChatViewProps) {
  const showBanner = !hasAnyMessages && !isStreaming;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {showBanner && <Banner version={version} updateAvailable={updateAvailable} />}
      {messages.map((msg) => (
        <MessageBlock key={msg.id} message={msg} debugMode={debugMode} />
      ))}
      {activeToolCall && (
        <Box marginLeft={2}>
          <Text color="yellow">Running tool: {activeToolCall}...</Text>
        </Box>
      )}
      {isStreaming && streamingContent && (
        <Box flexDirection="column" marginBottom={1}>
          {debugMode && <Text bold color="green">Cerebrum</Text>}
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
