import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { z } from 'zod';

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

export async function executeReadFile(args: z.infer<typeof readFileParameters>): Promise<string> {
  const filePath = resolve(args.path);
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
  const filePath = resolve(args.path);
  try {
    writeFileSync(filePath, args.content, 'utf-8');
    return `File written: ${filePath}`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeListDirectory(args: z.infer<typeof listDirectoryParameters>): Promise<string> {
  const dirPath = resolve(args.path);
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
