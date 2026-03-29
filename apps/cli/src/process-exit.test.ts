import { describe, expect, it, vi } from 'vitest';
import { prepareForExit } from './process-exit.js';

describe('prepareForExit', () => {
  it('disables raw mode and pauses tty stdin', () => {
    const setRawMode = vi.fn();
    const pause = vi.fn();

    prepareForExit({
      isTTY: true,
      setRawMode,
      pause,
    });

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('skips raw mode cleanup for non-tty stdin', () => {
    const setRawMode = vi.fn();
    const pause = vi.fn();

    prepareForExit({
      isTTY: false,
      setRawMode,
      pause,
    });

    expect(setRawMode).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
  });
});
