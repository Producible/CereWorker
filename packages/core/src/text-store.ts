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
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

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

export function writeTextFileAtomic(path: string, content: string): void {
  ensureDir(dirname(path));
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, 'utf-8');
  rmSync(path, { force: true });
  renameSync(tempPath, path);
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
