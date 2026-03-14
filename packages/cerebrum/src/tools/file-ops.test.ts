import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeReadFile, executeWriteFile, executeListDirectory } from './file-ops.js';

describe('file-ops', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('executeReadFile', () => {
    it('reads an existing file', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      const file = join(dir, 'hello.txt');
      writeFileSync(file, 'hello world', 'utf-8');
      const result = await executeReadFile({ path: file, maxLines: 2000 });
      expect(result).toBe('hello world');
    });

    it('returns error for nonexistent file', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      const result = await executeReadFile({ path: join(dir, 'missing.txt'), maxLines: 2000 });
      expect(result).toContain('File not found');
    });

    it('truncates at maxLines', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      const file = join(dir, 'long.txt');
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      writeFileSync(file, lines.join('\n'), 'utf-8');
      const result = await executeReadFile({ path: file, maxLines: 5 });
      expect(result).toContain('line 1');
      expect(result).toContain('line 5');
      expect(result).toContain('more lines');
      expect(result).not.toContain('line 100');
    });
  });

  describe('executeWriteFile', () => {
    it('writes a new file', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      const file = join(dir, 'new.txt');
      const result = await executeWriteFile({ path: file, content: 'new content' });
      expect(result).toContain('File written');
      const readBack = await executeReadFile({ path: file, maxLines: 2000 });
      expect(readBack).toBe('new content');
    });

    it('overwrites an existing file', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      const file = join(dir, 'overwrite.txt');
      writeFileSync(file, 'old', 'utf-8');
      await executeWriteFile({ path: file, content: 'new' });
      const readBack = await executeReadFile({ path: file, maxLines: 2000 });
      expect(readBack).toBe('new');
    });
  });

  describe('executeListDirectory', () => {
    it('lists files with sizes', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      writeFileSync(join(dir, 'a.txt'), 'hello', 'utf-8');
      const result = await executeListDirectory({ path: dir });
      expect(result).toContain('a.txt');
      expect(result).toContain('B');
    });

    it('lists directories with trailing slash', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      mkdirSync(join(dir, 'subdir'));
      const result = await executeListDirectory({ path: dir });
      expect(result).toContain('subdir/');
    });

    it('returns empty string for empty directory', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      const result = await executeListDirectory({ path: dir });
      expect(result).toBe('');
    });

    it('returns error for nonexistent directory', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      const result = await executeListDirectory({ path: join(dir, 'nope') });
      expect(result).toContain('Directory not found');
    });

    it('shows KB for larger files', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      writeFileSync(join(dir, 'big.bin'), Buffer.alloc(2048, 'x'));
      const result = await executeListDirectory({ path: dir });
      expect(result).toContain('KB');
    });

    it('shows MB for large files', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cereworker-fileops-test-'));
      writeFileSync(join(dir, 'huge.bin'), Buffer.alloc(2 * 1024 * 1024, 'x'));
      const result = await executeListDirectory({ path: dir });
      expect(result).toContain('MB');
    });
  });
});
