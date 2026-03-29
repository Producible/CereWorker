type ExitInput = Pick<NodeJS.ReadStream, 'isTTY' | 'pause'> & {
  setRawMode?: (mode: boolean) => void;
};

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve());
  });
}

export function prepareForExit(stdin: ExitInput = process.stdin): void {
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(false);
    } catch {
      // Ignore cleanup failures when stdin is not in raw mode.
    }
  }

  stdin.pause();
}

export async function exitOneShot(code = 0): Promise<never> {
  prepareForExit();
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  process.exit(code);
}
