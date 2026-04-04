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
const PROJECT_DIR = 'project';
const DAILY_DIR = 'daily';
const SESSION_DIR = 'session';
const TRAINING_DIR = 'training';

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
    this.ensureSubdir(PROJECT_DIR);
    this.ensureSubdir(DAILY_DIR);
    this.ensureSubdir(SESSION_DIR);
    this.ensureSubdir(TRAINING_DIR);
  }

  /** Seed MEMORY.md with initial content if it doesn't exist yet. */
  seedMemory(content: string): boolean {
    const primaryPath = this.projectMemoryPath();
    if (existsSync(primaryPath) || existsSync(this.legacyProjectMemoryPath())) return false;
    writeFileSync(primaryPath, content, 'utf-8');
    return true;
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

  get projectDir(): string {
    return join(this.dir, PROJECT_DIR);
  }

  get dailyDir(): string {
    return join(this.dir, DAILY_DIR);
  }

  get sessionDir(): string {
    return join(this.dir, SESSION_DIR);
  }

  get trainingDir(): string {
    return join(this.dir, TRAINING_DIR);
  }

  /** Read the main MEMORY.md file. */
  readMemory(): string {
    const path = this.resolveProjectMemoryPathForRead();
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  /** Write/replace the main MEMORY.md file. */
  writeMemory(content: string): void {
    writeFileSync(this.projectMemoryPath(), content, 'utf-8');
  }

  /** Append content to today's daily log (YYYY-MM-DD.md). */
  appendDailyLog(content: string): void {
    const filename = `${this.todayDate()}.md`;
    const path = join(this.dailyDir, filename);
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
      .map((f) => {
        const path = this.resolveMemoryFilePath(`${f}.md`);
        if (!path) {
          throw new Error(`Unable to resolve daily log path for ${f}.md`);
        }
        return {
          filename: `${f}.md`,
          content: readFileSync(path, 'utf-8'),
          date: f,
        };
      });
  }

  /** List all daily log files (date strings, sorted). */
  listLogFiles(): string[] {
    const files = new Set<string>();
    if (existsSync(this.dailyDir)) {
      for (const file of readdirSync(this.dailyDir)) {
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(file)) {
          files.add(file.replace('.md', ''));
        }
      }
    }
    if (existsSync(this.dir)) {
      for (const file of readdirSync(this.dir)) {
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(file)) {
          files.add(file.replace('.md', ''));
        }
      }
    }
    return Array.from(files).sort();
  }

  /** List all files in the memory directory. */
  listAll(): string[] {
    const files = new Set<string>();
    if (existsSync(this.resolveProjectMemoryPathForRead())) {
      files.add(MEMORY_FILE);
    }
    for (const date of this.listLogFiles()) {
      files.add(`${date}.md`);
    }
    if (existsSync(this.sessionDir)) {
      for (const file of readdirSync(this.sessionDir)) {
        if (file.endsWith('.md')) {
          files.add(`session/${file}`);
        }
      }
    }
    if (existsSync(this.projectDir)) {
      for (const file of readdirSync(this.projectDir)) {
        if (file.endsWith('.md') && file !== MEMORY_FILE) {
          files.add(`project/${file}`);
        }
      }
    }
    return Array.from(files).sort();
  }

  /** Read a specific file from the memory directory. */
  readFile(filename: string): string | null {
    const path = this.resolveMemoryFilePath(filename);
    if (!path) return null;
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  /** Search across all memory files for a text pattern. */
  search(query: string): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    const lowerQuery = query.toLowerCase();

    for (const file of this.listAll()) {
      const content = this.readFile(file);
      if (content === null) continue;
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
        const layeredPath = join(this.dailyDir, `${dateStr}.md`);
        const legacyPath = join(this.dir, `${dateStr}.md`);
        if (existsSync(layeredPath)) {
          unlinkSync(layeredPath);
        } else if (existsSync(legacyPath)) {
          unlinkSync(legacyPath);
        }
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

  readSessionMemory(sessionId: string): string {
    const path = this.getSessionMemoryPath(sessionId);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  writeSessionMemory(sessionId: string, content: string): void {
    writeFileSync(this.getSessionMemoryPath(sessionId), content, 'utf-8');
  }

  appendSessionTurn(sessionId: string, user: string, assistant: string): void {
    const path = this.getSessionMemoryPath(sessionId);
    const entry =
      `\n## ${new Date().toISOString()}\n\n` +
      `**User**\n${user.trim()}\n\n` +
      `**Assistant**\n${assistant.trim()}\n`;
    appendFileSync(path, entry, 'utf-8');
  }

  private todayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private legacyProjectMemoryPath(): string {
    return join(this.dir, MEMORY_FILE);
  }

  private projectMemoryPath(): string {
    return join(this.projectDir, MEMORY_FILE);
  }

  private resolveProjectMemoryPathForRead(): string {
    const layered = this.projectMemoryPath();
    if (existsSync(layered)) return layered;
    return this.legacyProjectMemoryPath();
  }

  private getSessionMemoryPath(sessionId: string): string {
    return join(this.sessionDir, `${this.sanitizeSegment(sessionId)}.md`);
  }

  private sanitizeSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
  }

  private resolveMemoryFilePath(filename: string): string | null {
    const normalized = filename
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment && segment !== '.' && segment !== '..')
      .join('/');

    if (!normalized) return null;
    if (normalized === MEMORY_FILE) return this.resolveProjectMemoryPathForRead();
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(normalized)) {
      const layered = join(this.dailyDir, normalized);
      if (existsSync(layered)) return layered;
      return join(this.dir, normalized);
    }
    if (normalized.startsWith('session/')) {
      return join(this.sessionDir, normalized.slice('session/'.length));
    }
    if (normalized.startsWith('project/')) {
      return join(this.projectDir, normalized.slice('project/'.length));
    }
    if (normalized.startsWith('daily/')) {
      return join(this.dailyDir, normalized.slice('daily/'.length));
    }
    return join(this.dir, normalized);
  }
}
