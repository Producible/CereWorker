import { describe, expect, it } from 'vitest';
import { buildFinalConfig } from './config-builder.js';

describe('buildFinalConfig', () => {
  it('replaces onboarding-managed sections while preserving unrelated config', () => {
    const finalConfig = buildFinalConfig({
      cerebrum: {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: { envRef: 'ANTHROPIC_API_KEY' },
        auth: 'apikey',
      },
      cerebellum: {
        enabled: false,
      },
      channels: [],
      dmPolicy: 'pairing',
      gateway: {
        mode: 'standalone',
      },
      existingConfig: {
        profile: {
          name: 'Cere',
          role: 'general-purpose assistant',
        },
        channels: {
          dmPolicy: 'open',
          discord: {
            enabled: true,
            token: '${DISCORD_TOKEN}',
          },
        },
        gateway: {
          mode: 'node',
          gatewayUrl: 'ws://gateway-host:18800',
          nodeId: 'node-west',
        },
        tui: {
          showActivity: false,
        },
      },
    });

    expect(finalConfig.profile).toEqual({
      name: 'Cere',
      role: 'general-purpose assistant',
    });
    expect(finalConfig.tui).toEqual({
      showActivity: false,
    });
    expect(finalConfig.cerebrum).toEqual({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-opus-4-7',
      providers: {
        anthropic: {
          apiKey: '${ANTHROPIC_API_KEY}',
        },
      },
    });
    expect(finalConfig.cerebellum).toEqual({
      enabled: false,
    });
    expect(finalConfig.channels).toEqual({
      dmPolicy: 'pairing',
    });
    expect(finalConfig).not.toHaveProperty('gateway');
  });

  it('persists discord channel IDs from onboarding', () => {
    const finalConfig = buildFinalConfig({
      cerebrum: {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: { envRef: 'ANTHROPIC_API_KEY' },
        auth: 'apikey',
      },
      cerebellum: {
        enabled: false,
      },
      channels: [
        {
          id: 'discord',
          credentials: {
            token: { envRef: 'DISCORD_TOKEN' },
          },
          channelIds: ['123', '456'],
        },
      ],
      dmPolicy: 'open',
      gateway: {
        mode: 'standalone',
      },
    });

    expect(finalConfig.channels).toEqual({
      dmPolicy: 'open',
      discord: {
        enabled: true,
        token: '${DISCORD_TOKEN}',
        channelIds: ['123', '456'],
      },
    });
  });
});
