#!/usr/bin/env node
// Copy browser extension to ~/.cereworker/extension/ on npm install

import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dest = join(homedir(), '.cereworker', 'extension');

try {
  const require = createRequire(import.meta.url);
  const browserPkg = require.resolve('@cereworker/browser');
  const extensionSrc = join(browserPkg.substring(0, browserPkg.lastIndexOf('dist')), 'extension');

  if (!existsSync(extensionSrc)) {
    // Browser package not found — skip silently
    process.exit(0);
  }

  mkdirSync(dest, { recursive: true });
  cpSync(extensionSrc, dest, { recursive: true });
  console.log(`CereWorker: Browser extension copied to ${dest}`);
  console.log('           Load it in Chrome: chrome://extensions → Load unpacked → select that folder');
} catch {
  // Non-critical — don't fail the install
}
