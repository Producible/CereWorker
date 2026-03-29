import { describe, expect, it } from 'vitest';
import { Partials } from 'discord.js';
import { getDiscordClientOptions, shouldHandleDiscordMessage } from './discord.js';

describe('discord adapter helpers', () => {
  it('includes channel partials so DMs can be received', () => {
    expect(getDiscordClientOptions().partials).toContain(Partials.Channel);
  });

  it('always handles direct messages', () => {
    expect(shouldHandleDiscordMessage({
      isDM: true,
      isMentioned: false,
      routeIds: ['123'],
      channelIds: [],
    })).toBe(true);
  });

  it('handles mentioned guild messages', () => {
    expect(shouldHandleDiscordMessage({
      isDM: false,
      isMentioned: true,
      routeIds: ['123'],
      channelIds: [],
    })).toBe(true);
  });

  it('handles configured guild channels without mentions', () => {
    expect(shouldHandleDiscordMessage({
      isDM: false,
      isMentioned: false,
      routeIds: ['thread-1', 'channel-1'],
      channelIds: ['channel-1'],
    })).toBe(true);
  });

  it('ignores unrelated guild messages', () => {
    expect(shouldHandleDiscordMessage({
      isDM: false,
      isMentioned: false,
      routeIds: ['123'],
      channelIds: ['456'],
    })).toBe(false);
  });
});
