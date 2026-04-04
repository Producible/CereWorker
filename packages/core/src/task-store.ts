import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { TaskDefinition, TaskRunRecord } from './types.js';
import { createLogger } from './logger.js';
import {
  appendJsonLine,
  ensureDir,
  readJsonLines,
  resolveStoreBasePath,
  withTextStoreLock,
  writeJsonFileAtomic,
} from './text-store.js';

const log = createLogger('task-store');
const DEFAULT_DB_PATH = join(homedir(), '.cereworker', 'tasks');

interface TaskStoreFileShape {
  tasks: TaskDefinition[];
}

export class TaskStore {
  private readonly inMemory: boolean;
  private readonly baseDir: string | null;
  private readonly definitionsPath: string | null;
  private readonly runsDir: string | null;
  private memoryTasks = new Map<string, TaskDefinition>();
  private memoryRuns = new Map<string, TaskRunRecord[]>();
  private definitionsCache: TaskStoreFileShape | null = null;
  private definitionsCacheMtimeMs: number | null = null;

  constructor(basePath?: string) {
    this.inMemory = basePath === ':memory:';
    this.baseDir = this.inMemory ? null : resolveStoreBasePath(basePath ?? DEFAULT_DB_PATH);
    this.definitionsPath = this.baseDir ? join(this.baseDir, 'definitions.json') : null;
    this.runsDir = this.baseDir ? join(this.baseDir, 'runs') : null;

    if (this.baseDir) {
      ensureDir(this.baseDir);
      ensureDir(this.runsDir!);
    }
  }

  list(): TaskDefinition[] {
    if (this.inMemory) {
      return Array.from(this.memoryTasks.values()).map((task) => ({ ...task }));
    }
    const file = this.readDefinitionsFile();
    return file.tasks.map((task) => ({ ...task }));
  }

  get(taskId: string): TaskDefinition | undefined {
    if (this.inMemory) {
      const task = this.memoryTasks.get(taskId);
      return task ? { ...task } : undefined;
    }
    const file = this.readDefinitionsFile();
    const task = file.tasks.find((entry) => entry.id === taskId);
    return task ? { ...task } : undefined;
  }

  upsert(task: TaskDefinition): TaskDefinition {
    if (this.inMemory) {
      this.memoryTasks.set(task.id, { ...task });
      return { ...task };
    }

    return withTextStoreLock(this.baseDir!, () => {
      const file = this.readDefinitionsFile();
      const index = file.tasks.findIndex((existing) => existing.id === task.id);
      if (index >= 0) {
        file.tasks[index] = { ...task };
      } else {
        file.tasks.push({ ...task });
      }
      this.writeDefinitionsFile(file.tasks);
      return { ...task };
    });
  }

  remove(taskId: string): boolean {
    if (this.inMemory) return this.memoryTasks.delete(taskId);

    return withTextStoreLock(this.baseDir!, () => {
      const file = this.readDefinitionsFile();
      const filtered = file.tasks.filter((task) => task.id !== taskId);
      if (filtered.length === file.tasks.length) return false;
      this.writeDefinitionsFile(filtered);
      return true;
    });
  }

  appendRun(taskId: string, run: Omit<TaskRunRecord, 'id' | 'taskId'>): TaskRunRecord {
    const record: TaskRunRecord = {
      id: nanoid(12),
      taskId,
      ...run,
    };
    if (this.inMemory) {
      const rows = this.memoryRuns.get(taskId) ?? [];
      rows.push(record);
      this.memoryRuns.set(taskId, rows);
      return record;
    }

    withTextStoreLock(this.baseDir!, () => {
      appendJsonLine(this.getRunPath(taskId), record);
    });
    return record;
  }

  listRuns(taskId: string): TaskRunRecord[] {
    if (this.inMemory) return [...(this.memoryRuns.get(taskId) ?? [])];
    return readJsonLines<TaskRunRecord>(this.getRunPath(taskId));
  }

  private getRunPath(taskId: string): string {
    return join(this.runsDir ?? dirname(DEFAULT_DB_PATH), `${taskId}.jsonl`);
  }

  private readDefinitionsFile(): TaskStoreFileShape {
    if (!this.definitionsPath || !existsSync(this.definitionsPath)) {
      this.definitionsCache = { tasks: [] };
      this.definitionsCacheMtimeMs = null;
      return { tasks: [] };
    }
    try {
      const stat = statSync(this.definitionsPath);
      if (this.definitionsCache && this.definitionsCacheMtimeMs === stat.mtimeMs) {
        return {
          tasks: this.definitionsCache.tasks.map((task) => ({ ...task })),
        };
      }
      const raw = JSON.parse(readFileSync(this.definitionsPath, 'utf-8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tasks: [] };
      const tasks = Array.isArray((raw as { tasks?: unknown[] }).tasks)
        ? ((raw as { tasks: TaskDefinition[] }).tasks ?? [])
        : [];
      this.definitionsCache = { tasks: tasks.map((task) => ({ ...task })) };
      this.definitionsCacheMtimeMs = stat.mtimeMs;
      return { tasks };
    } catch (error) {
      log.warn('Failed to read task definitions', { error: String(error) });
      return { tasks: [] };
    }
  }

  private writeDefinitionsFile(tasks: TaskDefinition[]): void {
    writeJsonFileAtomic(this.definitionsPath!, { tasks });
    try {
      this.definitionsCache = { tasks: tasks.map((task) => ({ ...task })) };
      this.definitionsCacheMtimeMs = existsSync(this.definitionsPath!)
        ? statSync(this.definitionsPath!).mtimeMs
        : null;
    } catch {
      this.definitionsCache = null;
      this.definitionsCacheMtimeMs = null;
    }
  }
}
