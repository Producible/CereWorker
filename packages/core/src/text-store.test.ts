import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  withTextStoreLock,
  writeTextFileAtomic,
} from './text-store.js';

describe('text-store locks', () => {
  let dir = '';

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('reclaims a stale lock held by a dead process', () => {
    dir = join(tmpdir(), `cereworker-text-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const target = join(dir, 'state.json');
    const lockDir = `${target}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: 999999,
      hostname: hostname(),
      acquiredAt: Date.now() - 60_000,
      targetPath: target,
    }, null, 2));

    const result = withTextStoreLock(target, () => 'acquired', { timeoutMs: 200, pollMs: 10, staleMs: 100 });

    expect(result).toBe('acquired');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('fails fast when a live lock is still busy', () => {
    dir = join(tmpdir(), `cereworker-text-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const target = join(dir, 'state.json');
    const lockDir = `${target}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: Date.now(),
      targetPath: target,
    }, null, 2));

    expect(() => withTextStoreLock(target, () => 'nope', { timeoutMs: 120, pollMs: 20, staleMs: 1_000 }))
      .toThrow('Text store busy');
  });

  it('replaces existing files atomically', () => {
    dir = join(tmpdir(), `cereworker-text-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const target = join(dir, 'state.json');
    writeTextFileAtomic(target, 'first\n');
    writeTextFileAtomic(target, 'second\n');

    expect(readFileSync(target, 'utf-8')).toBe('second\n');
  });
});
