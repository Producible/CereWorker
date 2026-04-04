import type {
  DailyAtTaskSchedule,
  IntervalTaskSchedule,
  OneShotTaskSchedule,
  TaskSchedule,
  TaskScheduleCatchUpPolicy,
  TaskScheduleUnit,
} from './types.js';

const INTERVAL_UNIT_ALIASES: Record<string, TaskScheduleUnit> = {
  minute: 'minutes',
  minutes: 'minutes',
  min: 'minutes',
  mins: 'minutes',
  hour: 'hours',
  hours: 'hours',
  hr: 'hours',
  hrs: 'hours',
  day: 'days',
  days: 'days',
  week: 'weeks',
  weeks: 'weeks',
};

export interface ScheduleNormalizationOptions {
  defaultTimezone?: string;
  defaultCatchUpPolicy?: TaskScheduleCatchUpPolicy;
}

function normalizeTimeString(value: string): string {
  const trimmed = value.trim();
  const twelveHourMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (twelveHourMatch) {
    let hour = Number(twelveHourMatch[1]) % 12;
    const minute = Number(twelveHourMatch[2] ?? '0');
    if (twelveHourMatch[3].toLowerCase() === 'pm') hour += 12;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const twentyFourHourMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    const hour = Number(twentyFourHourMatch[1]);
    const minute = Number(twentyFourHourMatch[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  throw new Error(`Invalid time string: ${value}`);
}

function normalizeIntervalSchedule(input: IntervalTaskSchedule): IntervalTaskSchedule {
  if (!Number.isFinite(input.every) || input.every <= 0) {
    throw new Error('Interval schedules require a positive "every" value.');
  }
  if (!['minutes', 'hours', 'days', 'weeks'].includes(input.unit)) {
    throw new Error(`Invalid interval unit: ${input.unit}`);
  }
  return {
    type: 'interval',
    every: Math.floor(input.every),
    unit: input.unit,
  };
}

function normalizeDailyAtSchedule(
  input: DailyAtTaskSchedule,
  options: ScheduleNormalizationOptions,
): DailyAtTaskSchedule {
  return {
    type: 'daily_at',
    time: normalizeTimeString(input.time),
    timezone: input.timezone ?? options.defaultTimezone,
    catchUpPolicy: input.catchUpPolicy ?? options.defaultCatchUpPolicy ?? 'once',
  };
}

function normalizeOneShotSchedule(
  input: OneShotTaskSchedule,
  options: ScheduleNormalizationOptions,
): OneShotTaskSchedule {
  const dueAt = new Date(input.dueAt);
  if (Number.isNaN(dueAt.getTime())) {
    throw new Error(`Invalid one-shot dueAt: ${input.dueAt}`);
  }
  return {
    type: 'one_shot',
    dueAt: dueAt.toISOString(),
    timezone: input.timezone ?? options.defaultTimezone,
    catchUpPolicy: input.catchUpPolicy ?? options.defaultCatchUpPolicy ?? 'once',
  };
}

export function normalizeTaskSchedule(
  input: TaskSchedule | string,
  options: ScheduleNormalizationOptions = {},
): TaskSchedule {
  if (typeof input !== 'string') {
    if (input.type === 'interval') return normalizeIntervalSchedule(input);
    if (input.type === 'daily_at') return normalizeDailyAtSchedule(input, options);
    return normalizeOneShotSchedule(input, options);
  }

  const raw = input.trim();
  const lowered = raw.toLowerCase();
  if (lowered === 'hourly') {
    return { type: 'interval', every: 1, unit: 'hours' };
  }
  if (lowered === 'daily') {
    return { type: 'interval', every: 1, unit: 'days' };
  }
  if (lowered === 'weekly') {
    return { type: 'interval', every: 1, unit: 'weeks' };
  }

  const intervalMatch = lowered.match(/^every\s+(\d+)\s+([a-z]+)$/);
  if (intervalMatch) {
    const unit = INTERVAL_UNIT_ALIASES[intervalMatch[2]];
    if (!unit) {
      throw new Error(`Unsupported interval unit in schedule: ${input}`);
    }
    return { type: 'interval', every: Number(intervalMatch[1]), unit };
  }

  const dailyAtMatch = raw.match(/^daily\s+at\s+(.+)$/i);
  if (dailyAtMatch) {
    return normalizeDailyAtSchedule(
      { type: 'daily_at', time: dailyAtMatch[1] },
      options,
    );
  }

  const onceAtMatch = raw.match(/^(?:once|one[- ]shot)\s+(?:at|on)\s+(.+)$/i);
  if (onceAtMatch) {
    return normalizeOneShotSchedule(
      { type: 'one_shot', dueAt: onceAtMatch[1] },
      options,
    );
  }

  throw new Error(`Unsupported schedule string: ${input}`);
}

export function formatTaskSchedule(schedule: TaskSchedule): string {
  if (schedule.type === 'interval') {
    if (schedule.every === 1) {
      if (schedule.unit === 'hours') return 'every hour';
      if (schedule.unit === 'days') return 'every day';
      if (schedule.unit === 'weeks') return 'every week';
      return 'every minute';
    }
    return `every ${schedule.every} ${schedule.unit}`;
  }
  if (schedule.type === 'daily_at') {
    return `daily at ${schedule.time}${schedule.timezone ? ` (${schedule.timezone})` : ''}`;
  }
  return `once at ${schedule.dueAt}${schedule.timezone ? ` (${schedule.timezone})` : ''}`;
}

export function taskScheduleToHint(schedule: TaskSchedule): string {
  if (schedule.type === 'interval') {
    return formatTaskSchedule(schedule);
  }
  if (schedule.type === 'daily_at') {
    return `daily at ${schedule.time}`;
  }
  return `once at ${schedule.dueAt}`;
}

function zonedParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const actual = zonedParts(new Date(guess), timezone);
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const diff = desiredUtc - actualUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function getNextTaskRun(
  schedule: TaskSchedule,
  now = new Date(),
  options: { lastRunAt?: string; timezone?: string } = {},
): Date | null {
  if (schedule.type === 'interval') {
    const base = options.lastRunAt ? new Date(options.lastRunAt) : now;
    const multiplier =
      schedule.unit === 'minutes' ? 60_000
        : schedule.unit === 'hours' ? 60 * 60_000
          : schedule.unit === 'days' ? 24 * 60 * 60_000
            : 7 * 24 * 60 * 60_000;
    return new Date(base.getTime() + schedule.every * multiplier);
  }

  if (schedule.type === 'one_shot') {
    return new Date(schedule.dueAt);
  }

  const timezone = schedule.timezone ?? options.timezone;
  if (!timezone) {
    const [hour, minute] = schedule.time.split(':').map(Number);
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  const [hour, minute] = schedule.time.split(':').map(Number);
  const parts = zonedParts(now, timezone);
  let candidate = zonedDateTimeToUtc(
    parts.year,
    parts.month,
    parts.day,
    hour,
    minute,
    0,
    timezone,
  );
  if (candidate <= now) {
    const nextDay = addDays(candidate, 1);
    const nextParts = zonedParts(nextDay, timezone);
    candidate = zonedDateTimeToUtc(
      nextParts.year,
      nextParts.month,
      nextParts.day,
      hour,
      minute,
      0,
      timezone,
    );
  }
  return candidate;
}
