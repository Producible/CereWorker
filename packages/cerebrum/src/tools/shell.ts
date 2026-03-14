import { execFile } from 'node:child_process';
import { z } from 'zod';
import { evaluateCommand, type ExecDecision } from './exec-policy.js';

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
  autoMode: boolean;
  onApprovalRequired?: (command: string) => Promise<boolean>;
  onBlocked?: (command: string, reason: string) => void;
}

const DEFAULT_CONFIG: ShellToolConfig = {
  enabled: true,
  denyList: ['rm -rf /'],
  timeout: 30000,
  maxOutputSize: 102400,
  autoMode: false,
};

export function createShellExecutor(config: Partial<ShellToolConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async function executeShell(args: ShellToolArgs): Promise<string> {
    if (!cfg.enabled) {
      return 'Shell execution is disabled';
    }

    const { command, cwd, timeout } = args;

    // Legacy deny list check (still active as fallback)
    for (const denied of cfg.denyList) {
      if (command.includes(denied)) {
        cfg.onBlocked?.(command, `matches deny list entry "${denied}"`);
        return `Command denied: matches deny list entry "${denied}"`;
      }
    }

    // Exec policy evaluation
    const decision: ExecDecision = evaluateCommand(command, cfg.autoMode);

    if (decision === 'block') {
      const reason = cfg.autoMode
        ? 'hard-blocked for safety'
        : 'blocked by exec policy (destructive or dangerous pattern)';
      cfg.onBlocked?.(command, reason);
      return `Command blocked: ${reason}`;
    }

    if (decision === 'ask' && cfg.onApprovalRequired) {
      const approved = await cfg.onApprovalRequired(command);
      if (!approved) {
        return 'Command denied by user';
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
