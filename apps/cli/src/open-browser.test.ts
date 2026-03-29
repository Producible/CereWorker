import { describe, expect, it } from 'vitest';
import { getBrowserLaunchCommand } from './open-browser.js';

describe('getBrowserLaunchCommand', () => {
  it('uses open on macOS', () => {
    expect(getBrowserLaunchCommand('https://example.com', 'darwin')).toEqual({
      command: 'open',
      args: ['https://example.com'],
    });
  });

  it('uses cmd start on Windows', () => {
    expect(getBrowserLaunchCommand('https://example.com', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'https://example.com'],
    });
  });

  it('uses xdg-open on Linux', () => {
    expect(getBrowserLaunchCommand('https://example.com', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com'],
    });
  });
});
