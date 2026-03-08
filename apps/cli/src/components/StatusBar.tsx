import React from 'react';
import { Box, Text } from 'ink';
import type { CerebellumStatus } from '@cereworker/core';

interface StatusBarProps {
  provider: string;
  model: string;
  cerebellumStatus: CerebellumStatus | null;
  isStreaming: boolean;
  channelCount?: number;
}

export function StatusBar({ provider, model, cerebellumStatus, isStreaming, channelCount = 0 }: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text color="cyan">{provider}/{model}</Text>
        <Text color={cerebellumStatus?.healthy ? 'green' : 'yellow'}>
          Cerebellum: {cerebellumStatus?.healthy ? 'connected' : 'offline'}
          {cerebellumStatus?.tasksRegistered ? ` (${cerebellumStatus.tasksRegistered} tasks)` : ''}
        </Text>
        {channelCount > 0 && (
          <Text color="green">Channels: {channelCount}</Text>
        )}
      </Box>
      <Box>
        {isStreaming && <Text color="yellow">streaming...</Text>}
      </Box>
    </Box>
  );
}
