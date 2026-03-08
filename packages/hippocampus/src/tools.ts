import { z } from 'zod';
import { HippocampusStore } from './store.js';

export const memoryReadParameters = z.object({
  file: z
    .string()
    .optional()
    .default('MEMORY.md')
    .describe('Memory file to read. Defaults to MEMORY.md. Use a date like "2026-03-08.md" for daily logs.'),
});

export const memoryWriteParameters = z.object({
  content: z.string().describe('Content to write to MEMORY.md (replaces existing content)'),
});

export const memoryLogParameters = z.object({
  content: z.string().describe("Content to append to today's daily log"),
});

export const memorySearchParameters = z.object({
  query: z.string().describe('Text to search for across all memory files'),
});

export function createMemoryTools(store: HippocampusStore) {
  return {
    executeMemoryRead: async (args: z.infer<typeof memoryReadParameters>): Promise<string> => {
      const content = store.readFile(args.file);
      if (content === null) {
        const files = store.listAll();
        if (files.length === 0) {
          return 'No memory files found. Use memory_write to create MEMORY.md or memory_log to start a daily log.';
        }
        return `File "${args.file}" not found. Available files: ${files.join(', ')}`;
      }
      return content || '(empty file)';
    },

    executeMemoryWrite: async (args: z.infer<typeof memoryWriteParameters>): Promise<string> => {
      store.writeMemory(args.content);
      return 'MEMORY.md updated successfully.';
    },

    executeMemoryLog: async (args: z.infer<typeof memoryLogParameters>): Promise<string> => {
      store.appendDailyLog(args.content);
      const today = new Date().toISOString().slice(0, 10);
      return `Logged to ${today}.md`;
    },

    executeMemorySearch: async (args: z.infer<typeof memorySearchParameters>): Promise<string> => {
      const results = store.search(args.query);
      if (results.length === 0) {
        return `No matches found for "${args.query}"`;
      }

      return results
        .map((r) => {
          const lines = r.content.split('\n');
          const matchingLines = lines
            .filter((l) => l.toLowerCase().includes(args.query.toLowerCase()))
            .slice(0, 5);
          return `## ${r.filename}\n${matchingLines.join('\n')}`;
        })
        .join('\n\n');
    },
  };
}
