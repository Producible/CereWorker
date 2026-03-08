import * as clack from '@clack/prompts';

export function guardCancel<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel('Setup cancelled.');
    process.exit(0);
  }
  return value;
}

export { clack };
