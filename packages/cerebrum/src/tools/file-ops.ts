import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';

/** Expand leading ~ to home directory, then resolve to absolute path. */
export function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return resolve(p);
}

export const readFileParameters = z.object({
  path: z.string().describe('Absolute or relative path to the file to read'),
  maxLines: z.number().optional().default(2000).describe('Maximum number of lines to read'),
});

export const writeFileParameters = z.object({
  path: z.string().describe('Absolute or relative path to the file to write'),
  content: z.string().describe('Content to write to the file'),
});

export const listDirectoryParameters = z.object({
  path: z.string().optional().default('.').describe('Directory path to list'),
});

export const globParameters = z.object({
  pattern: z.string().describe('Glob pattern to match files'),
  cwd: z.string().optional().default('.').describe('Base directory for the search'),
});

export const grepParameters = z.object({
  pattern: z.string().describe('Text or regex pattern to search for'),
  path: z.string().optional().default('.').describe('File or directory to search in'),
  maxResults: z.number().optional().default(50).describe('Maximum number of results'),
});

export const editFileParameters = z.object({
  path: z.string().describe('Absolute or relative path to the file to edit'),
  oldText: z.string().describe('Exact text to find in the file (must appear exactly once)'),
  newText: z.string().describe('Replacement text'),
});

export async function executeReadFile(args: z.infer<typeof readFileParameters>): Promise<string> {
  const filePath = expandPath(args.path);
  if (!existsSync(filePath)) {
    return `File not found: ${filePath}`;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > args.maxLines) {
      return lines.slice(0, args.maxLines).join('\n') + `\n... (${lines.length - args.maxLines} more lines)`;
    }
    return content;
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeWriteFile(args: z.infer<typeof writeFileParameters>): Promise<string> {
  const filePath = expandPath(args.path);
  try {
    writeFileSync(filePath, args.content, 'utf-8');
    return `File written: ${filePath}`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeListDirectory(args: z.infer<typeof listDirectoryParameters>): Promise<string> {
  const dirPath = expandPath(args.path);
  if (!existsSync(dirPath)) {
    return `Directory not found: ${dirPath}`;
  }
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries
      .map((e) => {
        const suffix = e.isDirectory() ? '/' : '';
        try {
          const stat = statSync(join(dirPath, e.name));
          const size = e.isDirectory() ? '' : ` (${formatSize(stat.size)})`;
          return `${e.name}${suffix}${size}`;
        } catch {
          return `${e.name}${suffix}`;
        }
      })
      .join('\n');
  } catch (err) {
    return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeEditFile(args: z.infer<typeof editFileParameters>): Promise<string> {
  const filePath = expandPath(args.path);
  if (!existsSync(filePath)) {
    return `File not found: ${filePath}`;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    const count = content.split(args.oldText).length - 1;
    if (count === 0) {
      return 'oldText not found in file. Verify the exact text exists (including whitespace and newlines).';
    }
    if (count > 1) {
      return `oldText appears ${count} times (ambiguous). Provide more surrounding context to make it unique.`;
    }
    const updated = content.replace(args.oldText, args.newText);
    writeFileSync(filePath, updated, 'utf-8');
    return `File edited: ${filePath}`;
  } catch (err) {
    return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeGrep(args: z.infer<typeof grepParameters>): Promise<string> {
  const searchPath = expandPath(args.path);
  if (!existsSync(searchPath)) {
    return `Path not found: ${searchPath}`;
  }

  const max = args.maxResults;

  // Try rg first, then grep, then fallback to pure-TS
  const tryExec = (cmd: string, cmdArgs: string[]): Promise<string | null> =>
    new Promise((res) => {
      execFile(cmd, cmdArgs, { maxBuffer: 1024 * 1024, timeout: 15000 }, (err, stdout) => {
        if (err && !stdout) return res(null); // command not found or fatal error
        res(stdout || null);
      });
    });

  const rgResult = await tryExec('rg', [
    '-n', '--no-heading', '--max-count', String(max), '--', args.pattern, searchPath,
  ]);
  if (rgResult !== null) {
    return rgResult.trim() || 'No matches found.';
  }

  const grepResult = await tryExec('grep', [
    '-rn', `--max-count=${max}`, '--', args.pattern, searchPath,
  ]);
  if (grepResult !== null) {
    return grepResult.trim() || 'No matches found.';
  }

  // Pure-TS fallback
  try {
    const results: string[] = [];
    const regex = new RegExp(args.pattern);
    searchRecursive(searchPath, regex, max, results);
    return results.length > 0 ? results.join('\n') : 'No matches found.';
  } catch (err) {
    return `Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function searchRecursive(dir: string, regex: RegExp, max: number, results: string[]): void {
  if (results.length >= max) return;
  const stat = statSync(dir);
  if (stat.isFile()) {
    try {
      const content = readFileSync(dir, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < max; i++) {
        if (regex.test(lines[i])) {
          results.push(`${dir}:${i + 1}:${lines[i]}`);
        }
      }
    } catch {
      // skip binary/unreadable files
    }
    return;
  }
  if (!stat.isDirectory()) return;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= max) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      searchRecursive(join(dir, entry.name), regex, max, results);
    }
  } catch {
    // skip unreadable directories
  }
}

export async function executeGlob(args: z.infer<typeof globParameters>): Promise<string> {
  const cwd = expandPath(args.cwd);
  if (!existsSync(cwd)) {
    return `Directory not found: ${cwd}`;
  }
  try {
    const matches = globSync(args.pattern, { cwd });
    if (matches.length === 0) {
      return 'No files matched.';
    }
    const sorted = [...matches].sort();
    const cap = 1000;
    if (sorted.length > cap) {
      return sorted.slice(0, cap).join('\n') + `\n... (${sorted.length - cap} more files)`;
    }
    return sorted.join('\n');
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
