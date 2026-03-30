export function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(
  abortSignal: AbortSignal | null | undefined,
  message: string,
): void {
  if (abortSignal?.aborted) {
    throw createAbortError(message);
  }
}

export function raceWithAbort<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal,
  message: string,
): Promise<T> {
  if (abortSignal.aborted) {
    return Promise.reject(createAbortError(message));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError(message));
    };

    const cleanup = () => {
      abortSignal.removeEventListener('abort', onAbort);
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
