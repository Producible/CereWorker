import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStore } from './task-store.js';
import type { TaskDefinition } from './types.js';

function makeTask(id: string): TaskDefinition {
  const now = new Date().toISOString();
  return {
    id,
    goal: `Goal for ${id}`,
    enabled: true,
    kind: 'recurring',
    schedule: { type: 'interval', every: 3, unit: 'hours' },
    autoMode: true,
    timeoutMinutes: 10,
    reportTarget: 'origin',
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
}

describe('TaskStore', () => {
  it('persists task definitions and run history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-task-store-'));
    const store = new TaskStore(dir);

    store.upsert(makeTask('x-daily'));
    store.appendRun('x-daily', {
      status: 'success',
      startedAt: '2026-04-04T22:00:00.000Z',
      completedAt: '2026-04-04T22:01:00.000Z',
      summary: 'Posted the daily update.',
    });

    const reloaded = new TaskStore(dir);
    expect(reloaded.get('x-daily')?.goal).toBe('Goal for x-daily');
    expect(reloaded.listRuns('x-daily')).toMatchObject([
      {
        taskId: 'x-daily',
        status: 'success',
        summary: 'Posted the daily update.',
      },
    ]);
  });

  it('removes task definitions without touching history files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-task-store-remove-'));
    const store = new TaskStore(dir);
    store.upsert(makeTask('temp-task'));
    store.appendRun('temp-task', {
      status: 'failure',
      startedAt: '2026-04-04T22:00:00.000Z',
      completedAt: '2026-04-04T22:02:00.000Z',
      summary: 'Task failed.',
      error: 'network',
    });

    expect(store.remove('temp-task')).toBe(true);
    expect(store.get('temp-task')).toBeUndefined();
    expect(store.listRuns('temp-task')).toHaveLength(1);
  });

  it('refreshes cached definitions when another store instance writes changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-task-store-cache-'));
    const first = new TaskStore(dir);
    const second = new TaskStore(dir);

    expect(first.list()).toEqual([]);
    second.upsert(makeTask('background-task'));

    expect(first.get('background-task')?.goal).toBe('Goal for background-task');
  });
});
