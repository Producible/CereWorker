import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('text-store');

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_POLL_MS = 100;
const DEFAULT_LOCK_STALE_MS = 30_000;
const LOCK_OWNER_FILE = 'owner.json';

interface TextStoreLockOwner {
  pid: number;
  hostname: string;
  acquiredAt: number;
  targetPath: string;
}

export interface TextStoreLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  staleMs?: number;
}

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, homedir());
}

export function resolveStoreBasePath(path: string): string {
  const resolved = resolve(expandHome(path));
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return resolved;
  }
  return extname(resolved) ? dirname(resolved) : resolved;
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getLockDir(path: string): string {
  return `${path}.lock`;
}

function getLockOwnerPath(lockDir: string): string {
  return join(lockDir, LOCK_OWNER_FILE);
}

function readLockOwner(lockDir: string): TextStoreLockOwner | null {
  return readJsonFile<TextStoreLockOwner | null>(getLockOwnerPath(lockDir), null);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

function tryAcquireLock(lockDir: string, targetPath: string): boolean {
  try {
    mkdirSync(lockDir);
    try {
      writeFileSync(getLockOwnerPath(lockDir), JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: Date.now(),
        targetPath,
      } satisfies TextStoreLockOwner, null, 2) + '\n', 'utf-8');
    } catch (error) {
      rmSync(lockDir, { recursive: true, force: true });
      throw error;
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    throw error;
  }
}

function tryReleaseStaleLock(lockDir: string, staleMs: number): boolean {
  if (!existsSync(lockDir)) return false;

  const owner = readLockOwner(lockDir);
  if (!owner) {
    const ageMs = Date.now() - statSync(lockDir).mtimeMs;
    if (ageMs < staleMs) return false;
    rmSync(lockDir, { recursive: true, force: true });
    log.warn('Removed stale text-store lock without owner metadata', { lockDir, ageMs: Math.round(ageMs) });
    return true;
  }

  const ageMs = Date.now() - owner.acquiredAt;
  if (ageMs < staleMs) return false;
  if (owner.hostname !== hostname()) return false;
  if (isProcessAlive(owner.pid)) return false;

  rmSync(lockDir, { recursive: true, force: true });
  log.warn('Removed stale text-store lock', {
    lockDir,
    targetPath: owner.targetPath,
    pid: owner.pid,
    ageMs: Math.round(ageMs),
  });
  return true;
}

export function withTextStoreLock<T>(targetPath: string, fn: () => T, options: TextStoreLockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const startedAt = Date.now();
  const lockDir = getLockDir(targetPath);
  ensureDir(dirname(lockDir));

  let waitLogged = false;
  while (!tryAcquireLock(lockDir, targetPath)) {
    if (tryReleaseStaleLock(lockDir, staleMs)) {
      continue;
    }

    const elapsedMs = Date.now() - startedAt;
    if (!waitLogged) {
      log.debug('Waiting for text-store lock', { targetPath, lockDir });
      waitLogged = true;
    }
    if (elapsedMs >= timeoutMs) {
      log.warn('Text-store lock timed out', { targetPath, lockDir, timeoutMs });
      throw new Error(`Text store busy: ${targetPath}`);
    }
    sleepMs(Math.min(pollMs, timeoutMs - elapsedMs));
  }

  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function writeTextFileAtomic(path: string, content: string): void {
  ensureDir(dirname(path));
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, 'utf-8');
  try {
    renameSync(tempPath, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY') && existsSync(path)) {
      rmSync(path, { force: true });
      renameSync(tempPath, path);
      return;
    }
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function writeJsonFileAtomic(path: string, value: unknown): void {
  writeTextFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

export function appendJsonLine(path: string, value: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(value) + '\n', 'utf-8');
}

export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((value): value is T => value !== null);
}

export function writeJsonLines(path: string, rows: unknown[]): void {
  const content = rows.length > 0
    ? rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    : '';
  writeTextFileAtomic(path, content);
}

export function uniqueBackupPath(path: string): string {
  let candidate = `${path}.bak`;
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = `${path}.bak.${counter}`;
    counter++;
  }
  return candidate;
}

export function readFileHeader(path: string, bytes: number): Buffer {
  if (!existsSync(path)) return Buffer.alloc(0);
  const content = readFileSync(path);
  return content.subarray(0, Math.min(bytes, content.length));
}

export function joinJsonlPath(dir: string, filename: string): string {
  return join(dir, filename);
}
