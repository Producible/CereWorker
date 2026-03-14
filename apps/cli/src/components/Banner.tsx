import React from 'react';
import { Box, Text } from 'ink';
import { LOGO_ART, LOGO_WIDTH } from './logo-data.js';

interface BannerProps {
  version: string;
}

export function Banner({ version }: BannerProps) {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box width={LOGO_WIDTH}>
        <Text>{LOGO_ART}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color="gray">v{version}</Text>
        <Text dimColor>Type a message to start chatting</Text>
        <Text dimColor>/help for commands  |  /model to switch models  |  /quit to exit</Text>
      </Box>
    </Box>
  );
}
