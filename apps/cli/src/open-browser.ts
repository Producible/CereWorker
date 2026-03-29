import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export interface BrowserLaunchCommand {
  command: string;
  args: string[];
}

export function getBrowserLaunchCommand(
  url: string,
  targetPlatform: NodeJS.Platform = platform(),
): BrowserLaunchCommand {
  if (targetPlatform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'start', '', url],
    };
  }

  return {
    command: targetPlatform === 'darwin' ? 'open' : 'xdg-open',
    args: [url],
  };
}

export function openBrowser(url: string): void {
  const { command, args } = getBrowserLaunchCommand(url);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });

  // Missing browser helpers should not crash the CLI after printing the fallback URL.
  child.once('error', () => {});
  child.unref();
}
