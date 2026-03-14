#!/usr/bin/env node
import React from 'react';
import { render, Text, Box } from 'ink';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '@cereworker/config';
import { App } from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Parse --debug flag from any position
  const debugFlag = process.argv.includes('--debug') || process.argv.includes('-d');
  if (debugFlag) {
    process.argv = process.argv.filter((a) => a !== '--debug' && a !== '-d');
  }

  // Parse --resume <id> flag
  let resumeId: string | undefined;
  const resumeIdx = process.argv.indexOf('--resume');
  if (resumeIdx !== -1 && process.argv[resumeIdx + 1]) {
    resumeId = process.argv[resumeIdx + 1];
    process.argv.splice(resumeIdx, 2);
  }

  // Handle subcommands that bypass Ink
  const subcommand = process.argv[2];
  if (subcommand === 'onboard') {
    const { runOnboardingWizard } = await import('./onboard/wizard.js');
    await runOnboardingWizard();
    return;
  }

  if (subcommand === 'setup') {
    const scriptPath = resolve(__dirname, '..', 'scripts', 'setup.sh');
    const args = process.argv.slice(3);
    try {
      execFileSync('bash', [scriptPath, ...args], { stdio: 'inherit' });
    } catch (err) {
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'auth') {
    const provider = process.argv[3];
    if (!provider) {
      console.error('Usage: cereworker auth <provider>');
      process.exit(1);
    }
    const { runAuth } = await import('./auth.js');
    await runAuth(provider);
    return;
  }

  if (subcommand === 'serve') {
    const { runHeadlessService } = await import('./serve.js');
    const config = loadConfig();
    if (debugFlag) config.logging.level = 'debug';
    await runHeadlessService(config);
    return;
  }

  try {
    const config = loadConfig();
    if (debugFlag) {
      const { configureLogger } = await import('@cereworker/core');
      configureLogger({ level: 'debug', stderr: true });
    }
    render(<App config={config} resumeConversationId={resumeId} />);
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
