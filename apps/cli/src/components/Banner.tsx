import React from 'react';
import { Box, Text } from 'ink';

interface BannerProps {
  version: string;
}

// "Cere" in cyan, "Worker" in magenta — standard figlet-style
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

export function Banner({ version }: BannerProps) {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column">
        {CERE.map((line, i) => (
          <Text key={i}>
            <Text color="cyan" bold>{line}</Text>
            <Text color="magenta" bold>{WORKER[i]}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color="gray">v{version}</Text>
        <Text dimColor>Type a message to start chatting</Text>
        <Text dimColor>/help for commands  |  /model to switch models  |  /quit to exit</Text>
      </Box>
    </Box>
  );
}
