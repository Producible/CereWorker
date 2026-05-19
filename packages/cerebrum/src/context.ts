import type { Message } from '@producible/cereworker-core';

/**
 * Build the prompt for the compaction LLM call.
 */
export function buildCompactionPrompt(messages: Message[]): string {
  const formatted = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  return `Summarize this conversation for an autonomous AI agent. This summary replaces the full history, so preserve everything needed to continue working.

Preserve:
- Current task state (what step are we on, what remains)
- File paths created, modified, or referenced
- Tool calls that succeeded and their key outputs
- Tool calls that failed and why (avoid retrying the same broken approach)
- Decisions made and their rationale
- User preferences (communication style, priorities, constraints)
- Credentials, API endpoints, or config values discovered
- Pending questions or action items

Format as short bullet points grouped by topic. Most actionable items first.
Do not include pleasantries, timestamps, or verbatim tool output.

---
${formatted}`;
}
