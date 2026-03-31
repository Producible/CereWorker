import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { MemoryEntry } from './types.js';

const DEFAULT_MEMORY_DIR = join(homedir(), '.cereworker', 'memory');
const MEMORY_FILE = 'MEMORY.md';

export class HippocampusStore {
  private readonly dir: string;

  constructor(directory?: string) {
    this.dir = directory
      ? resolve(directory.replace(/^~/, homedir()))
      : DEFAULT_MEMORY_DIR;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private ensureSubdir(subdir: string): void {
    const path = join(this.dir, subdir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }

  get directory(): string {
    return this.dir;
  }

  /** Read the main MEMORY.md file. */
  readMemory(): string {
    const path = join(this.dir, MEMORY_FILE);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  /** Write/replace the main MEMORY.md file. */
  writeMemory(content: string): void {
    writeFileSync(join(this.dir, MEMORY_FILE), content, 'utf-8');
  }

  /** Append content to today's daily log (YYYY-MM-DD.md). */
  appendDailyLog(content: string): void {
    const filename = `${this.todayDate()}.md`;
    const path = join(this.dir, filename);
    const entry = `\n---\n_${new Date().toISOString()}_\n\n${content}\n`;
    appendFileSync(path, entry, 'utf-8');
  }

  /** Read recent daily logs. */
  readDailyLogs(days: number = 7): MemoryEntry[] {
    const files = this.listLogFiles();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return files
      .filter((f) => f >= cutoffStr)
      .map((f) => ({
        filename: `${f}.md`,
        content: readFileSync(join(this.dir, `${f}.md`), 'utf-8'),
        date: f,
      }));
  }

  /** List all daily log files (date strings, sorted). */
  listLogFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace('.md', ''))
      .sort();
  }

  /** List all files in the memory directory. */
  listAll(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.md'));
  }

  /** Read a specific file from the memory directory. */
  readFile(filename: string): string | null {
    const safeName = filename.replace(/[/\\]/g, '');
    const path = join(this.dir, safeName);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  /** Search across all memory files for a text pattern. */
  search(query: string): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    const lowerQuery = query.toLowerCase();

    for (const file of this.listAll()) {
      const content = readFileSync(join(this.dir, file), 'utf-8');
      if (content.toLowerCase().includes(lowerQuery)) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        results.push({
          filename: file,
          content,
          date: dateMatch?.[1] ?? '',
        });
      }
    }

    return results;
  }

  /** Delete daily logs older than maxDays. */
  pruneOldLogs(maxDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    let pruned = 0;

    for (const dateStr of this.listLogFiles()) {
      if (dateStr < cutoffStr) {
        unlinkSync(join(this.dir, `${dateStr}.md`));
        pruned++;
      }
    }

    return pruned;
  }

  /** Get the finetune subdirectory path. */
  get finetuneDir(): string {
    const dir = basename(this.dir) === 'memory'
      ? join(dirname(this.dir), 'finetune')
      : join(this.dir, 'finetune');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private todayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
