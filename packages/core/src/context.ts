import type { Message } from './types.js';

const SAFETY_MARGIN = 1.2;

/**
 * Estimate token count using chars/4 heuristic with a 1.2x safety margin.
 * Avoids tiktoken dependency — same approach as OpenClaw.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * SAFETY_MARGIN);
}

/**
 * Estimate total tokens across an array of messages.
 */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    // Account for role/metadata overhead (~4 tokens per message)
    total += 4;
  }
  return total;
}

/**
 * Check if the conversation should be compacted.
 * Returns true when estimated tokens exceed threshold * contextWindow.
 */
export function shouldCompact(
  messages: Message[],
  contextWindow: number,
  threshold = 0.8,
): boolean {
  if (messages.length <= 1) return false;
  const tokens = estimateMessageTokens(messages);
  return tokens > contextWindow * threshold;
}

/**
 * Build the compacted message array: a system summary + the most recent messages.
 */
export function buildCompactionMessages(
  messages: Message[],
  summary: string,
  keepRecent: number,
): Message[] {
  const recentStart = Math.max(0, messages.length - keepRecent);
  const recentMessages = messages.slice(recentStart);

  const summaryMessage: Message = {
    id: 'compaction-summary',
    role: 'system',
    content: `[Previous conversation summary]\n${summary}`,
    timestamp: recentMessages[0]?.timestamp ?? Date.now(),
  };

  return [summaryMessage, ...recentMessages];
}
