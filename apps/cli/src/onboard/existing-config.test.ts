import { describe, expect, it } from 'vitest';
import { configSchema } from '@cereworker/config';
import {
  getCurrentCerebrumConfig,
  getCurrentChannelsConfig,
  getCurrentGatewayConfig,
} from './existing-config.js';

describe('existing onboarding config helpers', () => {
  it('normalizes legacy OpenAI OAuth config to openai-codex', () => {
    const existingConfig = configSchema.parse({
      cerebrum: {
        defaultProvider: 'openai-codex',
        defaultModel: 'gpt-5.4',
        providers: {
          'openai-codex': {
            auth: 'oauth',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
          },
        },
      },
    });

    const current = getCurrentCerebrumConfig(existingConfig, {
      cerebrum: {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.4',
        providers: {
          openai: {
            auth: 'oauth',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
          },
        },
      },
    });

    expect(current).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-5.4',
      auth: 'oauth',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    });
  });

  it('preserves env-var references for channels and gateway settings', () => {
    const existingConfig = configSchema.parse({
      channels: {
        dmPolicy: 'open',
        discord: {
          enabled: true,
          channelIds: ['123456789012345678'],
        },
        telegram: {
          enabled: true,
          allowFrom: ['12345'],
        },
      },
      gateway: {
        mode: 'node',
        gatewayUrl: 'ws://gateway-host:18800',
        nodeId: 'node-west',
        capabilities: ['shell', 'http'],
      },
    });

    const existingRaw = {
      channels: {
        dmPolicy: 'open',
        discord: {
          enabled: true,
          token: '${DISCORD_TOKEN}',
          channelIds: ['123456789012345678'],
        },
        telegram: {
          enabled: true,
          token: '${TELEGRAM_BOT_TOKEN}',
          allowFrom: ['12345'],
        },
      },
      gateway: {
        mode: 'node',
        gatewayUrl: 'ws://gateway-host:18800',
        nodeId: 'node-west',
        token: '${GATEWAY_TOKEN}',
        capabilities: ['shell', 'http'],
      },
    };

    const channels = getCurrentChannelsConfig(existingConfig, existingRaw);
    const gateway = getCurrentGatewayConfig(existingConfig, existingRaw);

    expect(channels).toEqual({
      dmPolicy: 'open',
      channels: [
        {
          id: 'discord',
          credentials: {
            token: { envRef: 'DISCORD_TOKEN' },
          },
          channelIds: ['123456789012345678'],
        },
        {
          id: 'telegram',
          credentials: {
            token: { envRef: 'TELEGRAM_BOT_TOKEN' },
          },
          allowFrom: ['12345'],
        },
      ],
    });
    expect(gateway).toEqual({
      mode: 'node',
      gatewayUrl: 'ws://gateway-host:18800',
      nodeId: 'node-west',
      token: { envRef: 'GATEWAY_TOKEN' },
      capabilities: ['shell', 'http'],
    });
  });
});
