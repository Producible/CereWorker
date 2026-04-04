import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HippocampusStore } from './store.js';

describe('HippocampusStore', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates directory on construction', () => {
    dir = join(mkdtempSync(join(tmpdir(), 'cereworker-store-test-')), 'sub');
    const store = new HippocampusStore(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('exposes directory via getter', () => {
    dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
    const store = new HippocampusStore(dir);
    expect(store.directory).toBe(dir);
  });

  describe('readMemory / writeMemory', () => {
    it('returns empty string when no MEMORY.md exists', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      expect(store.readMemory()).toBe('');
    });

    it('round-trips content', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      store.writeMemory('# Hello\nWorld');
      expect(store.readMemory()).toBe('# Hello\nWorld');
      expect(existsSync(join(dir, 'project', 'MEMORY.md'))).toBe(true);
    });

    it('overwrites existing content', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      store.writeMemory('old');
      store.writeMemory('new');
      expect(store.readMemory()).toBe('new');
    });
  });

  describe('appendDailyLog / readDailyLogs', () => {
    it('creates a date-stamped log file', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      store.appendDailyLog('test entry');
      const today = new Date().toISOString().slice(0, 10);
      expect(existsSync(join(dir, 'daily', `${today}.md`))).toBe(true);
    });

    it('readDailyLogs returns recent entries', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      store.appendDailyLog('entry');
      const logs = store.readDailyLogs(7);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].content).toContain('entry');
    });

    it('readDailyLogs filters by day range', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      // Create an old log file manually
      writeFileSync(join(dir, 'daily', '2020-01-01.md'), 'old entry', 'utf-8');
      store.appendDailyLog('recent entry');
      const logs = store.readDailyLogs(7);
      const dates = logs.map((l) => l.date);
      expect(dates).not.toContain('2020-01-01');
    });
  });

  describe('listLogFiles', () => {
    it('returns empty for empty directory', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      expect(store.listLogFiles()).toEqual([]);
    });

    it('returns sorted date strings', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      writeFileSync(join(dir, 'daily', '2024-03-15.md'), 'a', 'utf-8');
      writeFileSync(join(dir, 'daily', '2024-03-10.md'), 'b', 'utf-8');
      expect(store.listLogFiles()).toEqual(['2024-03-10', '2024-03-15']);
    });

    it('ignores non-date files', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      writeFileSync(join(dir, 'project', 'MEMORY.md'), 'x', 'utf-8');
      writeFileSync(join(dir, 'daily', '2024-03-15.md'), 'y', 'utf-8');
      expect(store.listLogFiles()).toEqual(['2024-03-15']);
    });
  });

  describe('listAll', () => {
    it('lists all .md files', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      writeFileSync(join(dir, 'project', 'MEMORY.md'), '', 'utf-8');
      writeFileSync(join(dir, 'daily', '2024-01-01.md'), '', 'utf-8');
      writeFileSync(join(dir, 'session', 'conv-1.md'), '', 'utf-8');
      writeFileSync(join(dir, 'notes.txt'), '', 'utf-8');
      const files = store.listAll();
      expect(files).toContain('MEMORY.md');
      expect(files).toContain('2024-01-01.md');
      expect(files).toContain('session/conv-1.md');
      expect(files).not.toContain('notes.txt');
    });
  });

  describe('readFile', () => {
    it('reads a specific file', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      writeFileSync(join(dir, 'session', 'test.md'), 'content', 'utf-8');
      expect(store.readFile('session/test.md')).toBe('content');
    });

    it('returns null for missing file', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      expect(store.readFile('nope.md')).toBeNull();
    });

    it('sanitizes path traversal', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      // Path traversal chars get stripped, so it looks for a local file
      expect(store.readFile('../../../etc/passwd')).toBeNull();
    });
  });

  describe('search', () => {
    it('finds matching content case-insensitively', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      writeFileSync(join(dir, 'session', 'notes.md'), 'TypeScript is great', 'utf-8');
      const results = store.search('typescript');
      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('session/notes.md');
    });

    it('returns empty for no matches', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      writeFileSync(join(dir, 'session', 'notes.md'), 'hello', 'utf-8');
      expect(store.search('zzzzz')).toHaveLength(0);
    });
  });

  describe('pruneOldLogs', () => {
    it('deletes old logs and returns count', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      writeFileSync(join(dir, 'daily', '2020-01-01.md'), 'old', 'utf-8');
      writeFileSync(join(dir, 'daily', '2020-01-02.md'), 'old', 'utf-8');
      store.appendDailyLog('recent');
      const pruned = store.pruneOldLogs(7);
      expect(pruned).toBe(2);
      expect(existsSync(join(dir, 'daily', '2020-01-01.md'))).toBe(false);
    });

    it('keeps recent logs', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      store.appendDailyLog('today');
      const pruned = store.pruneOldLogs(7);
      expect(pruned).toBe(0);
    });
  });

  describe('finetuneDir', () => {
    it('returns finetune path and creates directory', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      const ftDir = store.finetuneDir;
      expect(ftDir).toBe(join(dir, 'finetune'));
      expect(existsSync(ftDir)).toBe(true);
    });
  });

  describe('session memory', () => {
    it('stores per-session markdown history', () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-store-test-'));
      const store = new HippocampusStore(dir);
      store.appendSessionTurn('conv-1', 'Boss asked for status.', 'Reported current status.');
      const content = store.readSessionMemory('conv-1');
      expect(content).toContain('Boss asked for status.');
      expect(content).toContain('Reported current status.');
      expect(existsSync(join(dir, 'session', 'conv-1.md'))).toBe(true);
    });
  });
});
