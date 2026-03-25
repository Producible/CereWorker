import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanStore } from './plan-store.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `cereworker-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('PlanStore', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    dbPath = join(dir, 'test.db');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it('saves and retrieves a plan', () => {
    const store = new PlanStore(dbPath);
    const plan = store.save({
      taskId: 'task-1',
      goal: 'Deploy to prod',
      steps: [
        { description: 'Run tests', status: 'pending' },
        { description: 'Build image', status: 'pending' },
        { description: 'Push to registry', status: 'pending' },
      ],
      conversationId: 'conv-1',
      status: 'in_progress',
    });

    expect(plan.id).toBeDefined();
    expect(plan.goal).toBe('Deploy to prod');
    expect(plan.steps).toHaveLength(3);
    expect(plan.status).toBe('in_progress');

    const loaded = store.get(plan.id);
    expect(loaded).toBeDefined();
    expect(loaded!.goal).toBe('Deploy to prod');
    expect(loaded!.steps).toHaveLength(3);
  });

  it('returns undefined for non-existent plan', () => {
    const store = new PlanStore(dbPath);
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('lists in-progress plans', () => {
    const store = new PlanStore(dbPath);
    store.save({ taskId: 'a', goal: 'A', steps: [], status: 'in_progress' });
    store.save({ taskId: 'b', goal: 'B', steps: [], status: 'completed' });
    store.save({ taskId: 'c', goal: 'C', steps: [], status: 'in_progress' });

    const inProgress = store.getInProgress();
    expect(inProgress).toHaveLength(2);
    expect(inProgress.map((p) => p.goal).sort()).toEqual(['A', 'C']);
  });

  it('gets plan by task ID', () => {
    const store = new PlanStore(dbPath);
    store.save({ taskId: 'deploy', goal: 'Deploy v1', steps: [], status: 'completed' });
    store.save({ taskId: 'deploy', goal: 'Deploy v2', steps: [], status: 'in_progress' });

    const plan = store.getByTask('deploy');
    expect(plan).toBeDefined();
    expect(plan!.goal).toBe('Deploy v2');
  });

  it('updates plan status', () => {
    const store = new PlanStore(dbPath);
    const plan = store.save({ goal: 'Test', steps: [], status: 'in_progress' });

    store.updateStatus(plan.id, 'completed');
    const updated = store.get(plan.id);
    expect(updated!.status).toBe('completed');
  });

  it('updates individual step status', () => {
    const store = new PlanStore(dbPath);
    const plan = store.save({
      goal: 'Multi-step',
      steps: [
        { description: 'Step 1', status: 'pending' },
        { description: 'Step 2', status: 'pending' },
      ],
      status: 'in_progress',
    });

    store.updateStep(plan.id, 0, 'done');
    const updated = store.get(plan.id);
    expect(updated!.steps[0].status).toBe('done');
    expect(updated!.steps[1].status).toBe('pending');
  });

  it('deletes a plan', () => {
    const store = new PlanStore(dbPath);
    const plan = store.save({ goal: 'Delete me', steps: [], status: 'in_progress' });
    store.delete(plan.id);
    expect(store.get(plan.id)).toBeUndefined();
  });

  it('persists across store instances', () => {
    const store1 = new PlanStore(dbPath);
    const plan = store1.save({ goal: 'Persist', steps: [], status: 'in_progress' });

    const store2 = new PlanStore(dbPath);
    expect(store2.get(plan.id)).toBeDefined();
    expect(store2.get(plan.id)!.goal).toBe('Persist');
  });
});
