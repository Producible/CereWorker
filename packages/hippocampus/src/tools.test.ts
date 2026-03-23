import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HippocampusStore } from './store.js';
import { createMemoryTools } from './tools.js';

describe('createMemoryTools', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'cereworker-memtools-test-'));
    const store = new HippocampusStore(dir);
    return createMemoryTools(store);
  }

  describe('executeMemoryRead', () => {
    it('reads MEMORY.md by default', async () => {
      const tools = setup();
      writeFileSync(join(dir, 'MEMORY.md'), '# Memory', 'utf-8');
      const result = await tools.executeMemoryRead({ file: 'MEMORY.md' });
      expect(result).toBe('# Memory');
    });

    it('reads a specific file', async () => {
      const tools = setup();
      writeFileSync(join(dir, 'notes.md'), 'my notes', 'utf-8');
      const result = await tools.executeMemoryRead({ file: 'notes.md' });
      expect(result).toBe('my notes');
    });

    it('initializes MEMORY.md when no files exist', async () => {
      const tools = setup();
      const result = await tools.executeMemoryRead({ file: 'MEMORY.md' });
      expect(result).toContain('# Memory');
      // Should be readable on second call too
      const result2 = await tools.executeMemoryRead({ file: 'MEMORY.md' });
      expect(result2).toBe(result);
    });

    it('lists available files when file not found', async () => {
      const tools = setup();
      writeFileSync(join(dir, 'MEMORY.md'), 'x', 'utf-8');
      const result = await tools.executeMemoryRead({ file: 'missing.md' });
      expect(result).toContain('not found');
      expect(result).toContain('MEMORY.md');
    });

    it('returns (empty file) for empty content', async () => {
      const tools = setup();
      writeFileSync(join(dir, 'empty.md'), '', 'utf-8');
      const result = await tools.executeMemoryRead({ file: 'empty.md' });
      expect(result).toBe('(empty file)');
    });
  });

  describe('executeMemoryWrite', () => {
    it('writes content and returns success', async () => {
      const tools = setup();
      const result = await tools.executeMemoryWrite({ content: '# Hello' });
      expect(result).toContain('updated successfully');
      const readBack = await tools.executeMemoryRead({ file: 'MEMORY.md' });
      expect(readBack).toBe('# Hello');
    });
  });

  describe('executeMemoryLog', () => {
    it('appends to daily log and returns date', async () => {
      const tools = setup();
      const result = await tools.executeMemoryLog({ content: 'test log' });
      const today = new Date().toISOString().slice(0, 10);
      expect(result).toContain(today);
    });
  });

  describe('executeMemorySearch', () => {
    it('finds matching lines', async () => {
      const tools = setup();
      writeFileSync(join(dir, 'notes.md'), 'TypeScript rocks\nPython too', 'utf-8');
      const result = await tools.executeMemorySearch({ query: 'TypeScript' });
      expect(result).toContain('notes.md');
      expect(result).toContain('TypeScript rocks');
    });

    it('returns no matches message', async () => {
      const tools = setup();
      writeFileSync(join(dir, 'notes.md'), 'hello', 'utf-8');
      const result = await tools.executeMemorySearch({ query: 'zzzzz' });
      expect(result).toContain('No matches found');
    });
  });
});
