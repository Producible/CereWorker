#!/usr/bin/env node
// Post-install: copy browser extension + pull Cerebellum Docker image

import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

// --- 1. Copy browser extension to ~/.cereworker/extension/ ---

const dest = join(homedir(), '.cereworker', 'extension');

try {
  const require = createRequire(import.meta.url);
  const browserPkg = require.resolve('@cereworker/browser');
  const extensionSrc = join(browserPkg.substring(0, browserPkg.lastIndexOf('dist')), 'extension');

  if (existsSync(extensionSrc)) {
    mkdirSync(dest, { recursive: true });
    cpSync(extensionSrc, dest, { recursive: true });
    console.log(`CereWorker: Browser extension copied to ${dest}`);
    console.log('           Load it in Chrome: chrome://extensions → Load unpacked → select that folder');
  }
} catch {
  // Non-critical — don't fail the install
}

// --- 2. Pull latest Cerebellum Docker image ---

let dockerCmd = 'docker';

try {
  execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
} catch {
  // Docker not available directly — try with sudo
  try {
    execSync('sudo -n docker info', { stdio: 'pipe', timeout: 10_000 });
    dockerCmd = 'sudo docker';
  } catch {
    console.log('CereWorker: Docker not available — skipping Cerebellum image pull.');
    console.log('           Install Docker and run "cereworker images upgrade" to pull the image later.');
    process.exit(0);
  }
}

const image = 'cereworker/cerebellum:latest';
console.log(`CereWorker: Pulling ${image}...`);
try {
  execSync(`${dockerCmd} pull ${image}`, { stdio: 'inherit', timeout: 3_600_000 });
  console.log(`CereWorker: Cerebellum image updated.`);
} catch {
  console.log(`CereWorker: Could not pull ${image} (non-fatal). Run "cereworker images upgrade" to retry.`);
}
