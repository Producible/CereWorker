import type { CerebrumResult } from './steps/cerebrum.js';
import type { CerebellumResult } from './steps/cerebellum.js';
import type { ChannelSetup } from './steps/channels.js';

export interface BuildConfigParams {
  cerebrum: CerebrumResult;
  cerebellum: CerebellumResult;
  channels: ChannelSetup[];
  existingConfig?: Record<string, unknown> | null;
}

function resolveCredentialValue(value: string | { envRef: string }): string {
  if (typeof value === 'string') return value;
  return `\${${value.envRef}}`;
}

export function buildConfig(params: BuildConfigParams): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Cerebrum
  const cerebrum: Record<string, unknown> = {
    defaultProvider: params.cerebrum.provider,
    defaultModel: params.cerebrum.model,
  };

  if (params.cerebrum.provider === 'local') {
    cerebrum.providers = {
      local: {
        baseUrl: params.cerebrum.localBaseUrl ?? 'http://localhost:11434',
        model: params.cerebrum.model,
      },
    };
  } else if (params.cerebrum.apiKey) {
    const providerKey = params.cerebrum.provider;
    let apiKeyValue: string;

    if ('envRef' in params.cerebrum.apiKey) {
      apiKeyValue = `\${${params.cerebrum.apiKey.envRef}}`;
    } else {
      apiKeyValue = params.cerebrum.apiKey.plaintext;
    }

    cerebrum.providers = {
      [providerKey]: { apiKey: apiKeyValue },
    };
  }

  config.cerebrum = cerebrum;

  // Cerebellum
  if (params.cerebellum.enabled) {
    const cerebellum: Record<string, unknown> = {
      enabled: true,
    };

    if (params.cerebellum.model) {
      cerebellum.model = params.cerebellum.model;
    }

    if (params.cerebellum.finetune) {
      cerebellum.finetune = params.cerebellum.finetune;
    }

    cerebellum.docker = {
      autoStart: params.cerebellum.dockerAutoStart ?? true,
    };

    config.cerebellum = cerebellum;
  } else {
    config.cerebellum = { enabled: false };
  }

  // Channels
  if (params.channels.length > 0) {
    const channels: Record<string, unknown> = {};

    for (const ch of params.channels) {
      const channelConfig: Record<string, unknown> = { enabled: true };

      for (const [key, value] of Object.entries(ch.credentials)) {
        channelConfig[key] = resolveCredentialValue(value);
      }

      channels[ch.id] = channelConfig;
    }

    config.channels = channels;
  }

  return config;
}
