import { createRequire } from 'node:module';
import { nanoid } from 'nanoid';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';

const require = createRequire(import.meta.url);

function openDatabase(path: string) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path);
}

const log = createLogger('plan-store');

const DEFAULT_DB_PATH = join(homedir(), '.cereworker', 'conversations.db');

export type PlanStepStatus = 'pending' | 'done' | 'failed';
export type PlanStatus = 'in_progress' | 'completed' | 'failed' | 'abandoned';

export interface PlanStep {
  description: string;
  status: PlanStepStatus;
}

export interface Plan {
  id: string;
  taskId?: string;
  goal: string;
  steps: PlanStep[];
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
  status: PlanStatus;
}

export class PlanStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;

    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = openDatabase(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        taskId TEXT,
        goal TEXT NOT NULL,
        steps TEXT NOT NULL,
        conversationId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress'
      );

      CREATE INDEX IF NOT EXISTS idx_plans_status
        ON plans(status);
    `);
  }

  save(plan: Omit<Plan, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Plan {
    const now = new Date().toISOString();
    const full: Plan = {
      id: plan.id ?? nanoid(),
      taskId: plan.taskId,
      goal: plan.goal,
      steps: plan.steps,
      conversationId: plan.conversationId,
      createdAt: now,
      updatedAt: now,
      status: plan.status,
    };

    this.db
      .prepare(`INSERT OR REPLACE INTO plans (id, taskId, goal, steps, conversationId, createdAt, updatedAt, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        full.id,
        full.taskId ?? null,
        full.goal,
        JSON.stringify(full.steps),
        full.conversationId ?? null,
        full.createdAt,
        full.updatedAt,
        full.status,
      );

    log.debug('Saved plan', { id: full.id, status: full.status });
    return full;
  }

  get(id: string): Plan | undefined {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE id = ?')
      .get(id) as PlanRow | undefined;
    return row ? this.rowToPlan(row) : undefined;
  }

  getInProgress(): Plan[] {
    const rows = this.db
      .prepare("SELECT * FROM plans WHERE status = 'in_progress' ORDER BY createdAt ASC")
      .all() as unknown as PlanRow[];
    return rows.map((r) => this.rowToPlan(r));
  }

  getByTask(taskId: string): Plan | undefined {
    const row = this.db
      .prepare("SELECT * FROM plans WHERE taskId = ? AND status = 'in_progress' ORDER BY createdAt DESC LIMIT 1")
      .get(taskId) as PlanRow | undefined;
    return row ? this.rowToPlan(row) : undefined;
  }

  updateStatus(id: string, status: PlanStatus): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE plans SET status = ?, updatedAt = ? WHERE id = ?')
      .run(status, now, id);
    log.debug('Updated plan status', { id, status });
  }

  updateStep(planId: string, stepIndex: number, status: PlanStepStatus): void {
    const plan = this.get(planId);
    if (!plan || stepIndex < 0 || stepIndex >= plan.steps.length) return;
    plan.steps[stepIndex].status = status;
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE plans SET steps = ?, updatedAt = ? WHERE id = ?')
      .run(JSON.stringify(plan.steps), now, planId);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  }

  private rowToPlan(row: PlanRow): Plan {
    return {
      id: row.id,
      taskId: row.taskId ?? undefined,
      goal: row.goal,
      steps: JSON.parse(row.steps),
      conversationId: row.conversationId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      status: row.status as PlanStatus,
    };
  }
}

interface PlanRow {
  id: string;
  taskId: string | null;
  goal: string;
  steps: string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
}
