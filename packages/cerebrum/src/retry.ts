export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

const DEFAULTS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: true,
};

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();

  // Don't retry auth errors or bad requests
  if (msg.includes('401') || msg.includes('unauthorized')) return false;
  if (msg.includes('400') || msg.includes('bad request')) return false;
  if (msg.includes('context length') || msg.includes('too many tokens')) return false;
  if (msg.includes('invalid_api_key') || msg.includes('authentication')) return false;

  // Retry rate limits
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) return true;

  // Retry server errors
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  if (msg.includes('internal server error') || msg.includes('service unavailable')) return true;
  if (msg.includes('bad gateway') || msg.includes('gateway timeout')) return true;

  // Retry network errors
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('etimedout')) return true;
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('socket')) return true;
  if (msg.includes('overloaded')) return true;

  return false;
}

function computeDelay(attempt: number, opts: Required<RetryOptions>): number {
  const exponentialDelay = opts.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponentialDelay, opts.maxDelayMs);
  if (opts.jitter) {
    return capped * (0.5 + Math.random() * 0.5);
  }
  return capped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxAttempts - 1) break;
      if (!isRetryable(error)) break;

      const delay = computeDelay(attempt, opts);
      await sleep(delay);
    }
  }

  throw lastError;
}
