import React from 'react';
import { Box, Text } from 'ink';
import type { CerebellumStatus } from '@cereworker/core';

interface StatusBarProps {
  provider: string;
  model: string;
  cerebellumStatus: CerebellumStatus | null;
  isStreaming: boolean;
  channelCount?: number;
  autoMode?: boolean;
  gatewayMode?: 'gateway' | 'node' | 'standalone';
  gatewayNodeCount?: number;
  gatewayConnected?: boolean;
  gatewayUrl?: string;
  finetuneActive?: boolean;
  finetuneProgress?: number;
  dmPolicy?: 'pairing' | 'open';
}

export function StatusBar({
  provider,
  model,
  cerebellumStatus,
  isStreaming,
  channelCount = 0,
  autoMode = false,
  gatewayMode = 'standalone',
  gatewayNodeCount = 0,
  gatewayConnected = false,
  gatewayUrl,
  finetuneActive = false,
  finetuneProgress = 0,
  dmPolicy = 'pairing',
}: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text color="cyan">Cerebrum: {provider}/{model}</Text>
        <Text color={cerebellumStatus?.healthy ? 'green' : 'yellow'}>
          Cerebellum: {cerebellumStatus?.healthy ? 'connected' : 'offline'}
          {cerebellumStatus?.tasksRegistered ? ` (${cerebellumStatus.tasksRegistered} tasks)` : ''}
        </Text>
        {channelCount > 0 && (
          <Text color="green">Channels: {channelCount}</Text>
        )}
        {gatewayMode === 'gateway' && (
          <Text color="magenta">[GW] {gatewayNodeCount} node{gatewayNodeCount !== 1 ? 's' : ''}</Text>
        )}
        {gatewayMode === 'node' && (
          <Text color={gatewayConnected ? 'magenta' : 'yellow'}>
            [NODE{gatewayConnected ? '' : '?'}]
          </Text>
        )}
        {dmPolicy === 'pairing' && (
          <Text color="green">[PAIR]</Text>
        )}
        {finetuneActive && (
          <Text color="blue">[FT {Math.round(finetuneProgress * 100)}%]</Text>
        )}
        {autoMode && (
          <Text color="red" bold>AUTO</Text>
        )}
      </Box>
      <Box>
        {isStreaming && <Text color="yellow">streaming...</Text>}
      </Box>
    </Box>
  );
}
