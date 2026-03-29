function getWarningType(args: unknown[]): string | undefined {
  const second = args[1];
  if (typeof second === 'string') return second;
  if (second && typeof second === 'object' && 'type' in second && typeof second.type === 'string') {
    return second.type;
  }
  return undefined;
}

function getWarningName(args: unknown[]): string | undefined {
  const first = args[0];
  if (first && typeof first === 'object' && 'name' in first && typeof first.name === 'string') {
    return first.name;
  }
  return getWarningType(args);
}

function getWarningMessage(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'message' in first && typeof first.message === 'string') {
    return first.message;
  }
  return '';
}

export function shouldSuppressWarning(args: unknown[]): boolean {
  const name = getWarningName(args);
  const message = getWarningMessage(args);

  if (name === 'ExperimentalWarning' && message.includes('SQLite')) {
    return true;
  }

  if (name === 'DeprecationWarning' && message.includes('punycode')) {
    return true;
  }

  return false;
}

let installed = false;

export function installWarningFilter(): void {
  if (installed) return;
  installed = true;

  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const args = [warning, ...rest];
    if (shouldSuppressWarning(args)) {
      return;
    }
    return originalEmitWarning(warning as string & Error, ...rest as []);
  }) as typeof process.emitWarning;
}
