import { tool } from 'ai';
import {
  shellToolParameters,
  createShellExecutor,
  type ShellToolConfig,
} from './shell.js';
import {
  readFileParameters,
  writeFileParameters,
  listDirectoryParameters,
  executeReadFile,
  executeWriteFile,
  executeListDirectory,
} from './file-ops.js';

export function createBuiltinTools(shellConfig?: Partial<ShellToolConfig>) {
  const executeShell = createShellExecutor(shellConfig);

  return {
    shell: tool({
      description: 'Execute a shell command and return its output',
      parameters: shellToolParameters,
      execute: async (args) => executeShell(args),
    }),
    readFile: tool({
      description: 'Read the contents of a file',
      parameters: readFileParameters,
      execute: async (args) => executeReadFile(args),
    }),
    writeFile: tool({
      description: 'Write content to a file',
      parameters: writeFileParameters,
      execute: async (args) => executeWriteFile(args),
    }),
    listDirectory: tool({
      description: 'List files and directories in a given path',
      parameters: listDirectoryParameters,
      execute: async (args) => executeListDirectory(args),
    }),
  };
}

export type BuiltinTools = ReturnType<typeof createBuiltinTools>;
export type BuiltinToolName = keyof BuiltinTools;
