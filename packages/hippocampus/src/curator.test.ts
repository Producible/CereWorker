import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HippocampusStore } from './store.js';
import { HippocampusCurator, type TextGenerator } from './curator.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cereworker-curator-test-'));
  const store = new HippocampusStore(dir);
  const generator: TextGenerator = { generate: vi.fn() };
  const curator = new HippocampusCurator(store, generator);
  return { dir, store, generator, curator };
}

describe('HippocampusCurator', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('curate', () => {
    it('returns empty when no uncurated content', async () => {
      const ctx = setup();
      dir = ctx.dir;
      const result = await ctx.curator.curate();
      expect(result.pairs).toHaveLength(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('sends content to generator and parses JSON response', async () => {
      const ctx = setup();
      dir = ctx.dir;
      writeFileSync(join(dir, 'MEMORY.md'), 'User prefers dark mode', 'utf-8');

      const pairs = [{ instruction: 'What theme does the user prefer?', response: 'The user prefers dark mode.', source: 'MEMORY.md' }];
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(pairs));

      const result = await ctx.curator.curate();
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].instruction).toBe('What theme does the user prefer?');
      expect(result.pairs[0].response).toBe('The user prefers dark mode.');
      expect(ctx.generator.generate).toHaveBeenCalledOnce();
    });

    it('handles generator failure gracefully', async () => {
      const ctx = setup();
      dir = ctx.dir;
      writeFileSync(join(dir, 'MEMORY.md'), 'some content', 'utf-8');
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM down'));

      const result = await ctx.curator.curate();
      expect(result.pairs).toHaveLength(0);
      expect(result.errors).toContain('Cerebrum call failed: LLM down');
    });

    it('handles non-array response', async () => {
      const ctx = setup();
      dir = ctx.dir;
      writeFileSync(join(dir, 'MEMORY.md'), 'content', 'utf-8');
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockResolvedValue('"not an array"');

      const result = await ctx.curator.curate();
      expect(result.pairs).toHaveLength(0);
      expect(result.errors.some((e) => e.includes('not an array'))).toBe(true);
    });

    it('handles markdown code blocks in response', async () => {
      const ctx = setup();
      dir = ctx.dir;
      writeFileSync(join(dir, 'MEMORY.md'), 'info', 'utf-8');
      const json = JSON.stringify([{ instruction: 'What framework is used?', response: 'The project uses React with Ink for TUI.', source: 'x' }]);
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockResolvedValue('```json\n' + json + '\n```');

      const result = await ctx.curator.curate();
      expect(result.pairs).toHaveLength(1);
    });

    it('filters entries missing instruction or response', async () => {
      const ctx = setup();
      dir = ctx.dir;
      writeFileSync(join(dir, 'MEMORY.md'), 'content', 'utf-8');
      const data = [
        { instruction: 'What is the preferred theme?', response: 'The user prefers dark mode.', source: 'x' },
        { instruction: 'no response' },
        { response: 'no instruction' },
        {},
      ];
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(data));

      const result = await ctx.curator.curate();
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].instruction).toBe('What is the preferred theme?');
    });

    it('filters entries with instruction or response shorter than 10 chars', async () => {
      const ctx = setup();
      dir = ctx.dir;
      writeFileSync(join(dir, 'MEMORY.md'), 'content', 'utf-8');
      const data = [
        { instruction: 'short', response: 'also short', source: 'x' },
        { instruction: 'ok', response: 'yes that is fine', source: 'x' },
        { instruction: 'What is the deploy process?', response: 'Run deploy.sh from the project root.', source: 'x' },
      ];
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(data));

      const result = await ctx.curator.curate();
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].instruction).toBe('What is the deploy process?');
    });

    it('saves pairs to pending.jsonl', async () => {
      const ctx = setup();
      dir = ctx.dir;
      writeFileSync(join(dir, 'MEMORY.md'), 'content', 'utf-8');
      const pairs = [{ instruction: 'What database is used?', response: 'SQLite via node:sqlite built-in.', source: 'x' }];
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(pairs));

      await ctx.curator.curate();
      const pendingPath = join(ctx.store.finetuneDir, 'pending.jsonl');
      expect(existsSync(pendingPath)).toBe(true);
      const content = readFileSync(pendingPath, 'utf-8');
      expect(content).toContain('What database is used?');
    });

    it('updates curated marker', async () => {
      const ctx = setup();
      dir = ctx.dir;
      writeFileSync(join(dir, 'MEMORY.md'), 'content', 'utf-8');
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockResolvedValue('[]');

      await ctx.curator.curate();
      const marker = readFileSync(join(dir, '.curated-marker'), 'utf-8').trim();
      expect(marker).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('getPendingPairs', () => {
    it('returns empty when no pending file', () => {
      const ctx = setup();
      dir = ctx.dir;
      expect(ctx.curator.getPendingPairs()).toEqual([]);
    });

    it('parses JSONL lines', () => {
      const ctx = setup();
      dir = ctx.dir;
      const ftDir = ctx.store.finetuneDir;
      const lines = [
        JSON.stringify({ instruction: 'q1', response: 'a1', source: 's1', createdAt: 1 }),
        JSON.stringify({ instruction: 'q2', response: 'a2', source: 's2', createdAt: 2 }),
      ].join('\n');
      writeFileSync(join(ftDir, 'pending.jsonl'), lines + '\n', 'utf-8');

      const pairs = ctx.curator.getPendingPairs();
      expect(pairs).toHaveLength(2);
      expect(pairs[0].instruction).toBe('q1');
      expect(pairs[1].instruction).toBe('q2');
    });

    it('skips malformed lines', () => {
      const ctx = setup();
      dir = ctx.dir;
      const ftDir = ctx.store.finetuneDir;
      const lines = [
        JSON.stringify({ instruction: 'q1', response: 'a1', source: 's1', createdAt: 1 }),
        'not valid json {{{',
      ].join('\n');
      writeFileSync(join(ftDir, 'pending.jsonl'), lines + '\n', 'utf-8');

      const pairs = ctx.curator.getPendingPairs();
      expect(pairs).toHaveLength(1);
    });
  });

  describe('markConsumed', () => {
    it('moves pending to consumed dir and clears pending', () => {
      const ctx = setup();
      dir = ctx.dir;
      const ftDir = ctx.store.finetuneDir;
      writeFileSync(join(ftDir, 'pending.jsonl'), '{"a":1}\n', 'utf-8');

      ctx.curator.markConsumed();

      // Pending file should be empty
      expect(readFileSync(join(ftDir, 'pending.jsonl'), 'utf-8')).toBe('');
      // Consumed dir should exist with today's file
      const today = new Date().toISOString().slice(0, 10);
      expect(existsSync(join(ftDir, 'consumed', `${today}.jsonl`))).toBe(true);
    });

    it('is a no-op when no pending file exists', () => {
      const ctx = setup();
      dir = ctx.dir;
      // Should not throw
      expect(() => ctx.curator.markConsumed()).not.toThrow();
    });
  });

  describe('deduplication', () => {
    it('does not append duplicate pairs to pending.jsonl', async () => {
      const ctx = setup();
      dir = ctx.dir;
      const ftDir = ctx.store.finetuneDir;

      // Pre-seed pending with an existing pair
      const existing = JSON.stringify({
        instruction: 'What database is used?',
        response: 'SQLite via node:sqlite.',
        source: 'MEMORY.md',
        createdAt: 1,
      });
      writeFileSync(join(ftDir, 'pending.jsonl'), existing + '\n', 'utf-8');

      // Curate returns same instruction + a new one
      writeFileSync(join(dir, 'MEMORY.md'), 'content', 'utf-8');
      const data = [
        { instruction: 'What database is used?', response: 'Different answer here.', source: 'x' },
        { instruction: 'What framework is used?', response: 'React with Ink for TUI rendering.', source: 'x' },
      ];
      (ctx.generator.generate as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(data));

      await ctx.curator.curate();
      const pairs = ctx.curator.getPendingPairs();
      // Should have original + 1 new, not the duplicate
      expect(pairs).toHaveLength(2);
      expect(pairs[0].instruction).toBe('What database is used?');
      expect(pairs[1].instruction).toBe('What framework is used?');
    });
  });
});
