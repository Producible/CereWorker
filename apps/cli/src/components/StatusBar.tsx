import React from 'react';
import { Box, Text } from 'ink';
import type { CerebellumStatus } from '@cereworker/core';
import type { CerebellumLoading } from '../hooks/useCerebellum.js';

interface StatusBarProps {
  provider: string;
  model: string;
  cerebellumStatus: CerebellumStatus | null;
  cerebellumLoading?: CerebellumLoading | null;
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
  taskCount?: number;
  taskRunning?: number;
  extensionConnected?: boolean;
  cerebellumEnabled?: boolean;
}

function CerebellumIndicator({
  status,
  loading,
  enabled,
}: {
  status: CerebellumStatus | null;
  loading?: CerebellumLoading | null;
  enabled: boolean;
}) {
  if (status?.healthy) {
    return (
      <Text color="green">
        Cerebellum: connected
        {status.tasksRegistered ? ` (${status.tasksRegistered} tasks)` : ''}
      </Text>
    );
  }

  if (enabled && !status && loading) {
    const { phase, attempt, maxAttempts } = loading;
    const hasProgress = attempt !== undefined && maxAttempts !== undefined && maxAttempts > 0;
    const pct = hasProgress ? Math.round((attempt! / maxAttempts!) * 100) : 0;
    const barWidth = 15;
    const filled = hasProgress ? Math.round((pct / 100) * barWidth) : 0;
    const bar = hasProgress
      ? `[${'='.repeat(filled)}${filled < barWidth ? '>' : ''}${'.'.repeat(Math.max(0, barWidth - filled - 1))}]`
      : '';

    return (
      <Text color="yellow">
        Cerebellum: {phase} {bar}{hasProgress ? ` ${pct}%` : ''}
      </Text>
    );
  }

  if (enabled && !status) {
    return <Text color="yellow">Cerebellum: loading...</Text>;
  }

  return (
    <Text color="red" bold>
      Cerebellum: OFFLINE
      {status?.tasksRegistered ? ` (${status.tasksRegistered} tasks)` : ''}
    </Text>
  );
}

export function StatusBar({
  provider,
  model,
  cerebellumStatus,
  cerebellumLoading: loadingInfo = null,
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
  taskCount = 0,
  taskRunning = 0,
  extensionConnected = false,
  cerebellumEnabled = true,
}: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text color="cyan">Cerebrum: {provider}/{model}</Text>
        <CerebellumIndicator status={cerebellumStatus} loading={loadingInfo} enabled={cerebellumEnabled} />
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
        {extensionConnected && (
          <Text color="green">[EXT]</Text>
        )}
        {taskCount > 0 && (
          <Text color={taskRunning > 0 ? 'yellow' : 'blue'}>
            [TASKS {taskRunning > 0 ? `${taskRunning}/${taskCount}` : taskCount}]
          </Text>
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
