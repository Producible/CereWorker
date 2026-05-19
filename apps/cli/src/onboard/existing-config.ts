import {
  type CereWorkerConfig,
  getProviderAuthModes,
} from '@producible/cereworker-config';
import type { CerebellumResult } from './steps/cerebellum.js';
import type { ChannelSetup, ChannelsResult } from './steps/channels.js';
import type { CerebrumResult } from './steps/cerebrum.js';
import type { GatewayResult } from './steps/gateway.js';

const CHANNEL_IDS = ['slack', 'discord', 'telegram', 'matrix', 'feishu', 'wechat'] as const;
const LEGACY_OPENAI_PROVIDER = 'openai';
const OPENAI_CODEX_PROVIDER = 'openai-codex';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function parseStoredValue(value: unknown): string | { envRef: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const envRef = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
  return envRef ? { envRef } : value;
}

function parseStoredSecret(value: unknown): { envRef: string } | { plaintext: string } | undefined {
  const parsed = parseStoredValue(value);
  if (parsed === undefined) return undefined;
  return typeof parsed === 'string' ? { plaintext: parsed } : parsed;
}

function getRawCerebrumProviderConfig(
  existingRaw: Record<string, unknown>,
  provider: string,
): Record<string, unknown> | null {
  const cerebrum = asRecord(existingRaw.cerebrum);
  const providers = asRecord(cerebrum?.providers);
  const direct = asRecord(providers?.[provider]);
  if (direct) return direct;

  if (provider === OPENAI_CODEX_PROVIDER) {
    const legacy = asRecord(providers?.[LEGACY_OPENAI_PROVIDER]);
    if (legacy?.auth === 'oauth') {
      return legacy;
    }
  }

  return null;
}

export function getCurrentCerebrumConfig(
  existingConfig: CereWorkerConfig,
  existingRaw: Record<string, unknown>,
): CerebrumResult {
  const provider = existingConfig.cerebrum.defaultProvider;
  const rawProviderConfig = getRawCerebrumProviderConfig(existingRaw, provider);
  const providerConfig = asRecord(existingConfig.cerebrum.providers[provider as keyof typeof existingConfig.cerebrum.providers]);

  if (provider === 'local') {
    const rawLocal = asRecord(asRecord(asRecord(existingRaw.cerebrum)?.providers)?.local);
    return {
      provider,
      model: existingConfig.cerebrum.providers.local?.model ?? existingConfig.cerebrum.defaultModel,
      baseUrl: (rawLocal?.baseUrl as string | undefined) ?? existingConfig.cerebrum.providers.local?.baseUrl,
    };
  }

  const supportedAuthModes = getProviderAuthModes(provider);
  const resolvedAuth = rawProviderConfig?.auth === 'oauth' || providerConfig?.auth === 'oauth'
    ? 'oauth'
    : supportedAuthModes.length === 1 && supportedAuthModes[0] === 'oauth'
      ? 'oauth'
      : 'apikey';

  return {
    provider,
    model: existingConfig.cerebrum.defaultModel,
    auth: resolvedAuth,
    baseUrl: (rawProviderConfig?.baseUrl as string | undefined) ?? (providerConfig?.baseUrl as string | undefined),
    apiKey: parseStoredSecret(rawProviderConfig?.apiKey),
  };
}

export function summarizeCerebrumConfig(config: CerebrumResult): string {
  return `${config.provider} / ${config.model}`;
}

export function getCurrentCerebellumConfig(
  existingConfig: CereWorkerConfig,
  existingRaw: Record<string, unknown>,
): CerebellumResult {
  const rawCerebellum = asRecord(existingRaw.cerebellum);
  const rawDocker = asRecord(rawCerebellum?.docker);

  if (!existingConfig.cerebellum.enabled) {
    return { enabled: false };
  }

  return {
    enabled: true,
    model: rawCerebellum?.model
      ? existingConfig.cerebellum.model
      : existingConfig.cerebellum.model,
    finetune: existingConfig.cerebellum.finetune,
    dockerAutoStart: typeof rawDocker?.autoStart === 'boolean'
      ? rawDocker.autoStart
      : existingConfig.cerebellum.docker.autoStart,
    dockerImage: (rawDocker?.image as string | undefined) ?? existingConfig.cerebellum.docker.image,
  };
}

export function summarizeCerebellumConfig(config: CerebellumResult): string {
  if (!config.enabled) {
    return 'disabled';
  }
  const modelName = config.model?.id ?? config.model?.path ?? 'default';
  return `enabled (${modelName})`;
}

export function getCurrentChannelsConfig(
  existingConfig: CereWorkerConfig,
  existingRaw: Record<string, unknown>,
): ChannelsResult {
  const rawChannels = asRecord(existingRaw.channels);
  const channels: ChannelSetup[] = [];

  for (const channelId of CHANNEL_IDS) {
    const rawChannel = asRecord(rawChannels?.[channelId]);
    if (!rawChannel?.enabled) {
      continue;
    }

    const credentials: Record<string, string | { envRef: string }> = {};
    for (const [key, value] of Object.entries(rawChannel)) {
      if (key === 'enabled' || key === 'allowFrom' || key === 'channelIds') continue;
      const parsed = parseStoredValue(value);
      if (parsed !== undefined) {
        credentials[key] = parsed;
      }
    }

    const allowFrom = asStringArray(rawChannel.allowFrom)
      ?? existingConfig.channels[channelId].allowFrom;
    const channelIds = asStringArray(rawChannel.channelIds)
      ?? ('channelIds' in existingConfig.channels[channelId]
        ? asStringArray(existingConfig.channels[channelId].channelIds)
        : undefined);

    channels.push({
      id: channelId,
      credentials,
      ...(allowFrom && allowFrom.length > 0 ? { allowFrom } : {}),
      ...(channelIds && channelIds.length > 0 ? { channelIds } : {}),
    });
  }

  return {
    channels,
    dmPolicy: existingConfig.channels.dmPolicy,
  };
}

export function summarizeChannelsConfig(config: ChannelsResult): string {
  if (config.channels.length === 0) {
    return 'none';
  }
  return `${config.channels.map((channel) => channel.id).join(', ')} (DM policy: ${config.dmPolicy})`;
}

export function getCurrentGatewayConfig(
  existingConfig: CereWorkerConfig,
  existingRaw: Record<string, unknown>,
): GatewayResult {
  const rawGateway = asRecord(existingRaw.gateway);
  const mode = existingConfig.gateway.mode;

  if (mode === 'standalone') {
    return { mode };
  }

  if (mode === 'gateway') {
    return {
      mode,
      port: typeof rawGateway?.port === 'number' ? rawGateway.port : existingConfig.gateway.port,
      token: parseStoredValue(rawGateway?.token),
    };
  }

  return {
    mode,
    gatewayUrl: (rawGateway?.gatewayUrl as string | undefined) ?? existingConfig.gateway.gatewayUrl,
    nodeId: (rawGateway?.nodeId as string | undefined) ?? existingConfig.gateway.nodeId,
    token: parseStoredValue(rawGateway?.token),
    capabilities: asStringArray(rawGateway?.capabilities) ?? existingConfig.gateway.capabilities,
  };
}

export function summarizeGatewayConfig(config: GatewayResult): string {
  if (config.mode === 'standalone') {
    return 'standalone';
  }
  if (config.mode === 'gateway') {
    return `hub on port ${config.port ?? 18800}`;
  }
  return `node -> ${config.gatewayUrl ?? 'unknown gateway'} (${config.nodeId ?? 'unnamed'})`;
}
