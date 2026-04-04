import { describe, expect, it } from 'vitest';
import {
  formatTaskSchedule,
  getNextTaskRun,
  normalizeTaskSchedule,
  taskScheduleToHint,
} from './task-schedule.js';

describe('task-schedule', () => {
  it('normalizes legacy interval strings', () => {
    expect(normalizeTaskSchedule('every 3 hours')).toEqual({
      type: 'interval',
      every: 3,
      unit: 'hours',
    });
    expect(normalizeTaskSchedule('daily')).toEqual({
      type: 'interval',
      every: 1,
      unit: 'days',
    });
  });

  it('normalizes daily at strings with timezone defaults', () => {
    expect(normalizeTaskSchedule('daily at 10 pm', { defaultTimezone: 'America/Los_Angeles' })).toEqual({
      type: 'daily_at',
      time: '22:00',
      timezone: 'America/Los_Angeles',
      catchUpPolicy: 'once',
    });
  });

  it('formats schedules for prompts and heartbeat hints', () => {
    const schedule = normalizeTaskSchedule('every 3 hours');
    expect(formatTaskSchedule(schedule)).toBe('every 3 hours');
    expect(taskScheduleToHint(schedule)).toBe('every 3 hours');
  });

  it('computes the next interval run from lastRunAt', () => {
    const next = getNextTaskRun(
      { type: 'interval', every: 3, unit: 'hours' },
      new Date('2026-04-04T12:00:00Z'),
      { lastRunAt: '2026-04-04T09:00:00Z' },
    );
    expect(next?.toISOString()).toBe('2026-04-04T12:00:00.000Z');
  });

  it('computes the next one-shot run from dueAt', () => {
    const next = getNextTaskRun({
      type: 'one_shot',
      dueAt: '2026-04-04T22:00:00.000Z',
      timezone: 'UTC',
      catchUpPolicy: 'once',
    });
    expect(next?.toISOString()).toBe('2026-04-04T22:00:00.000Z');
  });
});
