#!/usr/bin/env node
// Post-install: copy browser extension + pull Cerebellum Docker image
// Uses stderr for output — npm suppresses stdout for global installs

import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

// --- 1. Copy browser extension to ~/.cereworker/extension/ ---

const dest = join(homedir(), '.cereworker', 'extension');

try {
  const require = createRequire(import.meta.url);
  const browserPkg = require.resolve('@producible/cereworker-browser');
  const extensionSrc = join(browserPkg.substring(0, browserPkg.lastIndexOf('dist')), 'extension');

  if (existsSync(extensionSrc)) {
    mkdirSync(dest, { recursive: true });
    cpSync(extensionSrc, dest, { recursive: true });
    log(`CereWorker: Browser extension installed to ${dest}`);
  }
} catch {
  // Non-critical — don't fail the install
}

// --- 2. Pull latest Cerebellum Docker image ---

// npm postinstall may have a restricted PATH — check common locations
let dockerBin = '';
try {
  execSync('docker --version', { stdio: 'pipe', timeout: 5_000 });
  dockerBin = 'docker';
} catch {
  for (const c of ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker']) {
    if (existsSync(c)) { dockerBin = c; break; }
  }
}

if (!dockerBin) {
  log('CereWorker: Docker not found — Cerebellum image will be pulled on first run.');
  process.exit(0);
}

let dockerCmd = dockerBin;

try {
  execSync(`${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
} catch {
  try {
    execSync(`sudo -n ${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
    dockerCmd = `sudo ${dockerBin}`;
  } catch {
    log('CereWorker: Docker requires sudo — Cerebellum image will be pulled on first run.');
    log('           Or run: cereworker images upgrade');
    process.exit(0);
  }
}

const image = 'producible/cereworker-cerebellum:latest';
log(`CereWorker: Pulling ${image}...`);
try {
  execSync(`${dockerCmd} pull ${image}`, { stdio: 'inherit', timeout: 3_600_000 });
  log('CereWorker: Cerebellum image updated.');
} catch {
  log(`CereWorker: Could not pull ${image}. Run "cereworker images upgrade" to retry.`);
}
