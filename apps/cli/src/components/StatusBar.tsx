import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { CerebellumStatus } from '@producible/cereworker-core';
import type { CerebellumLoading } from '../hooks/useCerebellum.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface StatusBarProps {
  provider: string;
  model: string;
  cerebellumStatus: CerebellumStatus | null;
  cerebellumLoading?: CerebellumLoading | null;
  isStreaming: boolean;
  showActivity?: boolean;
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
  streamStall?: boolean;
}

function CerebellumLoadingText({ loading }: { loading?: CerebellumLoading | null }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  const spinner = SPINNER_FRAMES[frame];
  const phase = loading?.phase || 'loading';
  const attempt = loading?.attempt && loading?.maxAttempts
    ? ` (${loading.attempt}/${loading.maxAttempts})`
    : '';

  return <Text color="yellow">{spinner} Cerebellum: {phase}{attempt}</Text>;
}

function CerebellumIndicator({
  status,
  loading,
  enabled,
  showActivity,
}: {
  status: CerebellumStatus | null;
  loading?: CerebellumLoading | null;
  enabled: boolean;
  showActivity: boolean;
}) {
  if (status?.healthy) {
    return (
      <Text color="green">
        Cerebellum: connected
        {status.tasksRegistered ? ` (${status.tasksRegistered} tasks)` : ''}
      </Text>
    );
  }

  if (enabled && !status) {
    if (!showActivity) {
      return <Text color="yellow">Cerebellum: starting</Text>;
    }
    return <CerebellumLoadingText loading={loading} />;
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
  showActivity = true,
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
  streamStall = false,
}: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text color="cyan">Cerebrum: {provider}/{model}</Text>
        <CerebellumIndicator
          status={cerebellumStatus}
          loading={loadingInfo}
          enabled={cerebellumEnabled}
          showActivity={showActivity}
        />
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
      <Box gap={1}>
        {streamStall && <Text color="red" bold>[STALL]</Text>}
        {showActivity && isStreaming && <Text color="yellow">streaming...</Text>}
      </Box>
    </Box>
  );
}
