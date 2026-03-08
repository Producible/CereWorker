#!/usr/bin/env node
import React from 'react';
import { render, Text, Box } from 'ink';
import { loadConfig } from '@cereworker/config';
import { App } from './app.js';

function main() {
  try {
    const config = loadConfig();
    render(<App config={config} />);
  } catch (err) {
    render(
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">Failed to start CereWorker</Text>
        <Text color="red">{err instanceof Error ? err.message : String(err)}</Text>
        <Text dimColor>Check your config at ~/.cereworker/config.yaml</Text>
      </Box>,
    );
    process.exit(1);
  }
}

main();
