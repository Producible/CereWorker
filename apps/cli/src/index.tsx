#!/usr/bin/env node

import { installWarningFilter } from './warnings.js';

installWarningFilter();

import React from 'react';
import { render, Text, Box } from 'ink';
import { createRequire } from 'node:module';
import { loadConfig } from '@cereworker/config';
import { App } from './app.js';
import { exitOneShot } from './process-exit.js';

const require = createRequire(import.meta.url);

async function main() {
  // --version / -v
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    const { version } = require('../package.json');
    console.log(version);
    try {
      const { checkForUpdate } = await import('./update-check.js');
      const latest = await Promise.race([
        checkForUpdate(version),
        new Promise<null>((r) => setTimeout(() => r(null), 500)),
      ]);
      if (latest) {
        console.log(`Update available: ${latest} — run: npm install -g @cereworker/cli`);
      }
    } catch {
      // Non-critical
    }
    await exitOneShot(0);
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
    await exitOneShot(0);
  }

  if (subcommand === 'configure') {
    const target = process.argv[3];
    if (target === 'profile') {
      const { runConfigureProfile } = await import('./configure.js');
      await runConfigureProfile();
      await exitOneShot(0);
    }
    if (target === 'model') {
      const { runConfigureModel } = await import('./configure.js');
      await runConfigureModel();
      await exitOneShot(0);
    }
    if (target === 'browser') {
      const { runConfigureBrowser } = await import('./configure.js');
      await runConfigureBrowser();
      await exitOneShot(0);
    }
    console.error('Usage: cereworker configure <profile|model|browser>');
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
    await exitOneShot(0);
  }

  if (subcommand === 'approve') {
    const code = process.argv[3];
    if (!code) {
      console.error('Usage: cereworker approve <CODE>');
      process.exit(1);
    }
    const { runApprove } = await import('./pairing.js');
    await runApprove(code);
    await exitOneShot(0);
  }

  if (subcommand === 'pairing') {
    const { runPairingList } = await import('./pairing.js');
    await runPairingList();
    await exitOneShot(0);
  }

  if (subcommand === 'extension-dir') {
    const { homedir: hd } = await import('node:os');
    const { join: pj } = await import('node:path');
    const { existsSync: ex } = await import('node:fs');
    const local = pj(hd(), '.cereworker', 'extension');
    if (ex(pj(local, 'manifest.json'))) {
      console.log(local);
    } else {
      // Fallback to npm package location
      const { createRequire: cr } = await import('node:module');
      const r = cr(import.meta.url);
      const p = r.resolve('@cereworker/browser');
      console.log(p.substring(0, p.lastIndexOf('dist')) + 'extension');
    }
    await exitOneShot(0);
  }

  if (subcommand === 'images') {
    const target = process.argv[3];
    if (target === 'upgrade') {
      const { runUpgrade } = await import('./upgrade.js');
      await runUpgrade();
      await exitOneShot(0);
    }
    // Default to list (also handles explicit "list")
    const { runImages } = await import('./images.js');
    await runImages();
    await exitOneShot(0);
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
    render(<App config={config} resumeConversationId={resumeId} />, { exitOnCtrlC: false });
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
