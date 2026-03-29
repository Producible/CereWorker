import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildChannelConversationKey,
  loadChannelConversationState,
  saveChannelConversationState,
} from './channel-conversations.js';

describe('buildChannelConversationKey', () => {
  it('uses sessionId when provided', () => {
    expect(buildChannelConversationKey({
      channelId: 'discord',
      senderId: 'user-1',
      sessionId: 'channel:123',
    })).toBe('discord:user-1:channel:123');
  });

  it('falls back to threadId and then default scope', () => {
    expect(buildChannelConversationKey({
      channelId: 'telegram',
      senderId: 'user-2',
      threadId: 'topic:456',
    })).toBe('telegram:user-2:topic:456');

    expect(buildChannelConversationKey({
      channelId: 'slack',
      senderId: 'user-3',
    })).toBe('slack:user-3:default');
  });
});

describe('channel conversation state', () => {
  it('round-trips persisted mappings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-channel-conversations-'));
    const file = join(dir, 'channel-conversations.json');

    saveChannelConversationState(file, {
      'discord:user-1:dm:123': 'conv-1',
      'telegram:user-2:chat:456': 'conv-2',
    });

    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      'discord:user-1:dm:123': 'conv-1',
      'telegram:user-2:chat:456': 'conv-2',
    });

    expect(loadChannelConversationState(file)).toEqual({
      'discord:user-1:dm:123': 'conv-1',
      'telegram:user-2:chat:456': 'conv-2',
    });
  });
});
