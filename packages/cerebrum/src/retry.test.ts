import { describe, it, expect, vi } from 'vitest';
import { withRetry } from './retry.js';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('401 Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry auth/bad request errors', async () => {
    for (const msg of ['invalid_api_key', '400 Bad Request', 'context length exceeded']) {
      const fn = vi.fn().mockRejectedValue(new Error(msg));
      await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(msg);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('retries rate limit errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('rate limit hit'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries network errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('back');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false });
    expect(result).toBe('back');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false }),
    ).rejects.toThrow('503 Service Unavailable');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects maxAttempts = 1 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('500 Internal Server Error'));
    await expect(
      withRetry(fn, { maxAttempts: 1, baseDelayMs: 1 }),
    ).rejects.toThrow('500');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-Error throws', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toBe('string error');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
