import type { ToolDefinition } from '@producible/cereworker-core';
import {
  shellToolParameters,
  createShellExecutor,
  type ShellToolConfig,
} from './shell.js';
import {
  readFileParameters,
  writeFileParameters,
  listDirectoryParameters,
  editFileParameters,
  globParameters,
  grepParameters,
  executeReadFile,
  executeWriteFile,
  executeListDirectory,
  executeEditFile,
  executeGlob,
  executeGrep,
} from './file-ops.js';

export function createBuiltinTools(shellConfig?: Partial<ShellToolConfig>) {
  const executeShell = createShellExecutor(shellConfig);

  return {
    shell: {
      description: 'Execute a shell command and return its output',
      parameters: shellToolParameters,
      execute: async (args) => executeShell(args as Parameters<typeof executeShell>[0]),
    },
    readFile: {
      description: 'Read the contents of a file',
      parameters: readFileParameters,
      execute: async (args) => executeReadFile(args as Parameters<typeof executeReadFile>[0]),
    },
    writeFile: {
      description: 'Write content to a file',
      parameters: writeFileParameters,
      execute: async (args) => executeWriteFile(args as Parameters<typeof executeWriteFile>[0]),
    },
    listDirectory: {
      description: 'List files and directories in a given path',
      parameters: listDirectoryParameters,
      execute: async (args) => executeListDirectory(args as Parameters<typeof executeListDirectory>[0]),
    },
    editFile: {
      description: 'Edit a file by replacing an exact text match. The oldText must appear exactly once.',
      parameters: editFileParameters,
      execute: async (args) => executeEditFile(args as Parameters<typeof executeEditFile>[0]),
    },
    searchFiles: {
      description: 'Search file contents using text or regex pattern. Returns matching lines with file paths and line numbers.',
      parameters: grepParameters,
      execute: async (args) => executeGrep(args as Parameters<typeof executeGrep>[0]),
    },
    glob: {
      description: 'Find files matching a glob pattern (e.g., "**/*.ts", "src/**/*.test.ts")',
      parameters: globParameters,
      execute: async (args) => executeGlob(args as Parameters<typeof executeGlob>[0]),
    },
  } satisfies Record<string, ToolDefinition>;
}

export type BuiltinTools = ReturnType<typeof createBuiltinTools>;
export type BuiltinToolName = keyof BuiltinTools;
