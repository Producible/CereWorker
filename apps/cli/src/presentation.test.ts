import { describe, expect, it } from 'vitest';
import type { Message } from '@producible/cereworker-core';
import { filterTranscriptMessages, formatChatTimestamp, formatLocalTimestamp } from './presentation.js';

describe('presentation helpers', () => {
  it('formats local timestamps with explicit timezone information', () => {
    const formatted = formatLocalTimestamp('2026-03-30T06:13:14.771Z', {
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
    });

    expect(formatted).toMatch(/03\/29\/2026, 23:13:14/);
    expect(formatted).toMatch(/PDT|GMT-7/);
  });

  it('formats chat timestamps with timezone in compact form', () => {
    const formatted = formatChatTimestamp('2026-03-30T06:13:14.771Z', {
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
    });

    expect(formatted).toMatch(/23:13/);
    expect(formatted).toMatch(/PDT|GMT-7/);
    // Should not contain date or seconds
    expect(formatted).not.toMatch(/2026/);
    expect(formatted).not.toMatch(/:14/);
  });

  it('filters transcript messages to user and cerebrum outside debug mode', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'hi', timestamp: 1 },
      { id: 's', role: 'system', content: 'system', timestamp: 2 },
      { id: 't', role: 'tool', content: 'tool', timestamp: 3 },
      { id: 'c', role: 'cerebrum', content: 'reply', timestamp: 4 },
    ];

    expect(filterTranscriptMessages(messages, false).map((message) => message.id)).toEqual(['u', 'c']);
    expect(filterTranscriptMessages(messages, true).map((message) => message.id)).toEqual(['u', 's', 't', 'c']);
  });
});
