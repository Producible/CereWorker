#!/usr/bin/env node

// Suppress node:sqlite ExperimentalWarning (stable API, flag removed in Node 22.13+)
const _origEmit = process.emit;
// @ts-expect-error — filtering warning events before they reach stderr
process.emit = function (event: string, ...args: unknown[]) {
  if (event === 'warning' && typeof args[0] === 'object' && args[0] !== null) {
    const w = args[0] as { name?: string; message?: string };
    // Suppress node:sqlite ExperimentalWarning (stable API, flag removed in Node 22.13+)
    if (w.name === 'ExperimentalWarning' && String(w.message).includes('SQLite')) return false;
    // Suppress punycode deprecation from transitive dependencies
    if (w.name === 'DeprecationWarning' && String(w.message).includes('punycode')) return false;
  }
  return _origEmit.apply(this, [event, ...args] as Parameters<typeof _origEmit>);
};

import React from 'react';
import { render, Text, Box } from 'ink';
import { createRequire } from 'node:module';
import { loadConfig } from '@cereworker/config';
import { App } from './app.js';

const require = createRequire(import.meta.url);

async function main() {
  // --version / -v
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    const { version } = require('../package.json');
    console.log(version);
    return;
  }

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

  if (subcommand === 'configure') {
    const target = process.argv[3];
    if (target === 'profile') {
      const { runConfigureProfile } = await import('./configure.js');
      await runConfigureProfile();
      return;
    }
    console.error('Usage: cereworker configure <profile>');
    process.exit(1);
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

  if (subcommand === 'approve') {
    const code = process.argv[3];
    if (!code) {
      console.error('Usage: cereworker approve <CODE>');
      process.exit(1);
    }
    const { runApprove } = await import('./pairing.js');
    await runApprove(code);
    return;
  }

  if (subcommand === 'pairing') {
    const { runPairingList } = await import('./pairing.js');
    await runPairingList();
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
