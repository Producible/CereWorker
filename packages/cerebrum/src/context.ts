import type { Message } from '@cereworker/core';

/**
 * Build the prompt for the compaction LLM call.
 */
export function buildCompactionPrompt(messages: Message[]): string {
  const formatted = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  return `Summarize the following conversation, preserving:
- Active tasks and their current status
- Key decisions made
- Important context and facts established
- Any pending questions or action items

Be concise but thorough. Do not lose critical details.

---
${formatted}`;
}
