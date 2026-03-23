import { tool } from 'ai';
import { z } from 'zod';
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
    shell: tool({ description: 'Execute a shell command and return its output', inputSchema: shellToolParameters, execute: async (args) => executeShell(args) }),
    readFile: tool({ description: 'Read the contents of a file', inputSchema: readFileParameters, execute: async (args) => executeReadFile(args) }),
    writeFile: tool({ description: 'Write content to a file', inputSchema: writeFileParameters, execute: async (args) => executeWriteFile(args) }),
    listDirectory: tool({ description: 'List files and directories in a given path', inputSchema: listDirectoryParameters, execute: async (args) => executeListDirectory(args) }),
    editFile: tool({ description: 'Edit a file by replacing an exact text match. The oldText must appear exactly once.', inputSchema: editFileParameters, execute: async (args) => executeEditFile(args) }),
    searchFiles: tool({ description: 'Search file contents using text or regex pattern. Returns matching lines with file paths and line numbers.', inputSchema: grepParameters, execute: async (args) => executeGrep(args) }),
    glob: tool({ description: 'Find files matching a glob pattern (e.g., "**/*.ts", "src/**/*.test.ts")', inputSchema: globParameters, execute: async (args) => executeGlob(args) }),
  };
}

export type BuiltinTools = ReturnType<typeof createBuiltinTools>;
export type BuiltinToolName = keyof BuiltinTools;
