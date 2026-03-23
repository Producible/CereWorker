import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProfileResult } from './steps/profile.js';
import type { CerebrumResult } from './steps/cerebrum.js';
import type { CerebellumResult } from './steps/cerebellum.js';
import type { ChannelSetup } from './steps/channels.js';
import type { GatewayResult } from './steps/gateway.js';

export interface BuildConfigParams {
  profile?: ProfileResult;
  cerebrum: CerebrumResult;
  cerebellum: CerebellumResult;
  channels: ChannelSetup[];
  dmPolicy?: 'pairing' | 'open';
  gateway?: GatewayResult;
  existingConfig?: Record<string, unknown> | null;
}

function findComposeFileFromCwd(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'docker-compose.yml');
    if (existsSync(candidate)) return resolve(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveCredentialValue(value: string | { envRef: string }): string {
  if (typeof value === 'string') return value;
  return `\${${value.envRef}}`;
}

export function buildConfig(params: BuildConfigParams): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Profile
  if (params.profile) {
    config.profile = {
      name: params.profile.name,
      role: params.profile.role,
      ...(params.profile.traits.length > 0 ? { traits: params.profile.traits } : {}),
    };
  }

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
  } else if (params.cerebrum.auth === 'oauth') {
    const providerKey = params.cerebrum.provider;
    cerebrum.providers = {
      [providerKey]: {
        auth: 'oauth',
        oauth: {
          clientId: params.cerebrum.oauthClientId,
          ...(params.cerebrum.oauthClientSecret ? { clientSecret: params.cerebrum.oauthClientSecret } : {}),
        },
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

    const docker: Record<string, unknown> = {
      autoStart: params.cerebellum.dockerAutoStart ?? true,
    };

    // Detect and store docker-compose.yml path so auto-start works from any cwd
    const composeFile = findComposeFileFromCwd();
    if (composeFile) {
      docker.composeFile = composeFile;
    }

    cerebellum.docker = docker;

    config.cerebellum = cerebellum;
  } else {
    config.cerebellum = { enabled: false };
  }

  // Channels
  if (params.channels.length > 0 || params.dmPolicy) {
    const channels: Record<string, unknown> = {};

    if (params.dmPolicy) {
      channels.dmPolicy = params.dmPolicy;
    }

    for (const ch of params.channels) {
      const channelConfig: Record<string, unknown> = { enabled: true };

      for (const [key, value] of Object.entries(ch.credentials)) {
        channelConfig[key] = resolveCredentialValue(value);
      }

      if (ch.allowFrom && ch.allowFrom.length > 0) {
        channelConfig.allowFrom = ch.allowFrom;
      }

      channels[ch.id] = channelConfig;
    }

    config.channels = channels;
  }

  // Gateway
  if (params.gateway && params.gateway.mode !== 'standalone') {
    const gw: Record<string, unknown> = {
      mode: params.gateway.mode,
    };
    if (params.gateway.mode === 'gateway') {
      gw.port = params.gateway.port ?? 18800;
    }
    if (params.gateway.mode === 'node') {
      gw.gatewayUrl = params.gateway.gatewayUrl;
      gw.nodeId = params.gateway.nodeId;
      if (params.gateway.capabilities?.length) {
        gw.capabilities = params.gateway.capabilities;
      }
    }
    if (params.gateway.token) {
      gw.token = resolveCredentialValue(params.gateway.token);
    }
    config.gateway = gw;
  }

  return config;
}
