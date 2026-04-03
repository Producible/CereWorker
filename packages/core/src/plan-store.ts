import { nanoid } from 'nanoid';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';
import {
  ensureDir,
  readJsonFile,
  resolveStoreBasePath,
  withTextStoreLock,
  writeJsonFileAtomic,
} from './text-store.js';
import { markLegacySectionMigrated, readLegacySection } from './legacy-sqlite.js';

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
  private readonly plansDir: string;

  constructor(dbPath?: string) {
    const baseDir = resolveStoreBasePath(dbPath ?? DEFAULT_DB_PATH);
    this.plansDir = join(baseDir, 'plans');
    ensureDir(this.plansDir);
    this.migrateLegacyDatabase(dbPath ?? DEFAULT_DB_PATH);
  }

  private migrateLegacyDatabase(dbPath: string): void {
    const rows = readLegacySection(
      dbPath,
      'plans',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db: any) => (
        db.prepare(
          `SELECT id, taskId, goal, steps, conversationId, createdAt, updatedAt, status
           FROM plans ORDER BY createdAt ASC`,
        ).all() as Array<{
          id: string;
          taskId: string | null;
          goal: string;
          steps: string;
          conversationId: string | null;
          createdAt: string;
          updatedAt: string;
          status: string;
        }>
      ).map((row) => ({
        id: row.id,
        taskId: row.taskId ?? undefined,
        goal: row.goal,
        steps: JSON.parse(row.steps),
        conversationId: row.conversationId ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        status: row.status as PlanStatus,
      })),
    );

    if (!rows) return;

    for (const plan of rows) {
      const path = this.getPlanPath(plan.id);
      if (existsSync(path)) continue;
      withTextStoreLock(path, () => {
        writeJsonFileAtomic(path, plan);
      });
    }

    markLegacySectionMigrated(dbPath, 'plans');
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

    withTextStoreLock(this.getPlanPath(full.id), () => {
      writeJsonFileAtomic(this.getPlanPath(full.id), full);
    });
    log.debug('Saved plan', { id: full.id, status: full.status });
    return full;
  }

  get(id: string): Plan | undefined {
    return readJsonFile<Plan | null>(this.getPlanPath(id), null) ?? undefined;
  }

  getInProgress(): Plan[] {
    return this.readAllPlans()
      .filter((plan) => plan.status === 'in_progress')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getByTask(taskId: string): Plan | undefined {
    return this.readAllPlans()
      .filter((plan) => plan.taskId === taskId && plan.status === 'in_progress')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  updateStatus(id: string, status: PlanStatus): void {
    const plan = this.get(id);
    if (!plan) return;
    plan.status = status;
    plan.updatedAt = new Date().toISOString();
    withTextStoreLock(this.getPlanPath(id), () => {
      writeJsonFileAtomic(this.getPlanPath(id), plan);
    });
    log.debug('Updated plan status', { id, status });
  }

  updateStep(planId: string, stepIndex: number, status: PlanStepStatus): void {
    const plan = this.get(planId);
    if (!plan || stepIndex < 0 || stepIndex >= plan.steps.length) return;
    plan.steps[stepIndex].status = status;
    plan.updatedAt = new Date().toISOString();
    withTextStoreLock(this.getPlanPath(planId), () => {
      writeJsonFileAtomic(this.getPlanPath(planId), plan);
    });
  }

  delete(id: string): void {
    withTextStoreLock(this.getPlanPath(id), () => {
      rmSync(this.getPlanPath(id), { force: true });
    });
  }

  private getPlanPath(id: string): string {
    return join(this.plansDir, `${id}.json`);
  }

  private readAllPlans(): Plan[] {
    if (!existsSync(this.plansDir)) return [];
    return readdirSync(this.plansDir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readJsonFile<Plan | null>(join(this.plansDir, entry), null))
      .filter((plan): plan is Plan => plan !== null);
  }
}
