import { execFile } from 'node:child_process';
import { z } from 'zod';

export const shellToolParameters = z.object({
  command: z.string().describe('The shell command to execute'),
  cwd: z.string().optional().describe('Working directory for the command'),
  timeout: z.number().optional().default(30000).describe('Timeout in milliseconds'),
});

export type ShellToolArgs = z.infer<typeof shellToolParameters>;

export interface ShellToolConfig {
  enabled: boolean;
  denyList: string[];
  timeout: number;
  maxOutputSize: number;
}

const DEFAULT_CONFIG: ShellToolConfig = {
  enabled: true,
  denyList: ['rm -rf /'],
  timeout: 30000,
  maxOutputSize: 102400,
};

export function createShellExecutor(config: Partial<ShellToolConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async function executeShell(args: ShellToolArgs): Promise<string> {
    if (!cfg.enabled) {
      return 'Shell execution is disabled';
    }

    const { command, cwd, timeout } = args;

    for (const denied of cfg.denyList) {
      if (command.includes(denied)) {
        return `Command denied: matches deny list entry "${denied}"`;
      }
    }

    return new Promise((resolve) => {
      execFile(
        'bash',
        ['-c', command],
        {
          cwd: cwd ?? process.cwd(),
          timeout: timeout ?? cfg.timeout,
          maxBuffer: cfg.maxOutputSize,
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              resolve(`Command timed out after ${timeout ?? cfg.timeout}ms`);
            } else {
              const output = [stdout, stderr, error.message].filter(Boolean).join('\n');
              resolve(truncate(output, cfg.maxOutputSize));
            }
          } else {
            const output = [stdout, stderr].filter(Boolean).join('\n');
            resolve(truncate(output, cfg.maxOutputSize) || '(no output)');
          }
        },
      );
    });
  };
}

function truncate(text: string, maxSize: number): string {
  if (text.length <= maxSize) return text;
  return text.slice(0, maxSize) + '\n... (output truncated)';
}
