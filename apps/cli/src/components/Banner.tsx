import React from 'react';
import { Box, Text } from 'ink';

interface BannerProps {
  version: string;
  updateAvailable?: string | null;
}

// "Cere" in red, "Worker" in orange
const CERE = [
  '   ____              ',
  '  / ___|___ _ __ ___ ',
  ' | |   / _ \\  __/ _ \\',
  ' | |__|  __/ | |  __/',
  '  \\____\\___|_|  \\___|',
];

const WORKER = [
  '__        __         _             ',
  '\\ \\      / /__  _ __| | _____ _ __ ',
  ' \\ \\ /\\ / / _ \\| \'__| |/ / _ \\  __|',
  '  \\ V  V / (_) | |  |   <  __/ |   ',
  '   \\_/\\_/ \\___/|_|  |_|\\_\\___|_|   ',
];

export function Banner({ version, updateAvailable }: BannerProps) {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column">
        {CERE.map((line, i) => (
          <Text key={i}>
            <Text color="red" bold>{line}</Text>
            <Text color="#FF8C00" bold>{WORKER[i]}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color="gray">v{version}</Text>
        {updateAvailable && (
          <Box flexDirection="column" alignItems="center" marginTop={1}>
            <Text color="yellow">Update available: {version} → {updateAvailable}</Text>
            <Text color="yellow">Run: npm install -g @producible/cereworker</Text>
          </Box>
        )}
        <Text dimColor>Type a message to start chatting</Text>
        <Text dimColor>/help for commands  |  /model to switch models  |  /quit to exit</Text>
      </Box>
    </Box>
  );
}
