import { describe, expect, it } from 'vitest';
import { createAbortError, raceWithAbort, throwIfAborted } from './abort.js';

describe('abort helpers', () => {
  it('creates AbortError instances with the expected name and message', () => {
    const error = createAbortError('operation aborted');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('operation aborted');
  });

  it('throws immediately when the signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();

    try {
      throwIfAborted(controller.signal, 'too late');
      throw new Error('Expected throwIfAborted to throw');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'AbortError',
        message: 'too late',
      });
    }
  });

  it('passes through resolved values when the signal stays active', async () => {
    const controller = new AbortController();

    await expect(
      raceWithAbort(Promise.resolve('ok'), controller.signal, 'unused'),
    ).resolves.toBe('ok');
  });

  it('rejects with AbortError when the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const pending = new Promise<string>(() => {});
    const raced = raceWithAbort(pending, controller.signal, 'mid-flight abort');

    controller.abort();

    await expect(raced).rejects.toMatchObject({
      name: 'AbortError',
      message: 'mid-flight abort',
    });
  });
});
