import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens, shouldCompact, buildCompactionMessages } from './context.js';
import type { Message } from './types.js';

function makeMessage(content: string, role: 'user' | 'cerebrum' = 'user'): Message {
  return { id: `msg-${Math.random()}`, role, content, timestamp: Date.now() };
}

describe('estimateTokens', () => {
  it('estimates tokens as ceil(chars/4 * 1.2)', () => {
    // 100 chars -> 100/4 * 1.2 = 30
    expect(estimateTokens('x'.repeat(100))).toBe(30);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles short text', () => {
    // "hi" = 2 chars -> ceil(2/4 * 1.2) = ceil(0.6) = 1
    expect(estimateTokens('hi')).toBe(1);
  });
});

describe('estimateMessageTokens', () => {
  it('sums token estimates for all messages plus overhead', () => {
    const messages = [
      makeMessage('x'.repeat(100)), // 30 tokens + 4 overhead
      makeMessage('y'.repeat(100)), // 30 tokens + 4 overhead
    ];
    expect(estimateMessageTokens(messages)).toBe(68);
  });

  it('returns 0 for empty array', () => {
    expect(estimateMessageTokens([])).toBe(0);
  });
});

describe('shouldCompact', () => {
  it('returns false for single message', () => {
    const messages = [makeMessage('hello')];
    expect(shouldCompact(messages, 100, 0.8)).toBe(false);
  });

  it('returns false when under threshold', () => {
    const messages = [
      makeMessage('hello'),
      makeMessage('world'),
    ];
    // 2 messages, ~5 tokens each with overhead -> ~18 total. 128000 * 0.8 = 102400
    expect(shouldCompact(messages, 128000, 0.8)).toBe(false);
  });

  it('returns true when over threshold', () => {
    // Create messages that exceed a small context window
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage('x'.repeat(400)), // ~120 tokens each + 4 overhead = 124 per msg
    );
    // 10 * 124 = 1240 tokens
    // With contextWindow=1000, threshold=0.8 -> trigger at 800 tokens
    expect(shouldCompact(messages, 1000, 0.8)).toBe(true);
  });

  it('uses default threshold of 0.8', () => {
    const messages = Array.from({ length: 10 }, () => makeMessage('x'.repeat(400)));
    expect(shouldCompact(messages, 1000)).toBe(true);
  });
});

describe('buildCompactionMessages', () => {
  it('returns summary + recent messages', () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage(`message ${i}`),
    );
    const result = buildCompactionMessages(messages, 'Summary of conversation', 2);

    expect(result).toHaveLength(3); // 1 summary + 2 recent
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('Summary of conversation');
    expect(result[0].content).toContain('[Previous conversation summary]');
    expect(result[1].content).toBe('message 3');
    expect(result[2].content).toBe('message 4');
  });

  it('keeps all messages when keepRecent >= total', () => {
    const messages = [makeMessage('only one')];
    const result = buildCompactionMessages(messages, 'Summary', 10);
    expect(result).toHaveLength(2); // summary + 1 message
    expect(result[1].content).toBe('only one');
  });

  it('summary message gets timestamp from first recent message', () => {
    const messages = [
      { ...makeMessage('old'), timestamp: 1000 },
      { ...makeMessage('new'), timestamp: 2000 },
    ];
    const result = buildCompactionMessages(messages, 'Summary', 1);
    expect(result[0].timestamp).toBe(2000);
  });
});
