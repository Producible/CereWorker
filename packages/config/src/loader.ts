import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { configSchema, type CereWorkerConfig } from './schema.js';
import { PROVIDER_ENV_VAR_MAP } from './cerebrum-providers.js';

const CONFIG_DIR = join(homedir(), '.cereworker');
const GLOBAL_CONFIG = join(CONFIG_DIR, 'config.yaml');
const GLOBAL_CONFIG_ALT = join(CONFIG_DIR, 'config.yml');
const LOCAL_CONFIG = '.cereworker.yaml';
const LOCAL_CONFIG_ALT = '.cereworker.yml';
const OPENAI_CODEX_PROVIDER = 'openai-codex';

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf-8');
  return (parseYaml(content) as Record<string, unknown>) ?? {};
}

function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }
  return obj;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeLegacyOpenAIOAuthConfig(config: Record<string, unknown>): Record<string, unknown> {
  const cerebrum = asRecord(config.cerebrum);
  if (!cerebrum) return config;

  const providers = asRecord(cerebrum.providers);
  if (!providers) return config;

  const openaiProvider = asRecord(providers.openai);
  if (openaiProvider?.auth !== 'oauth') return config;

  const nextProviders = { ...providers };
  if (!asRecord(nextProviders[OPENAI_CODEX_PROVIDER])) {
    nextProviders[OPENAI_CODEX_PROVIDER] = { ...openaiProvider };
  }

  const nextCerebrum: Record<string, unknown> = {
    ...cerebrum,
    providers: nextProviders,
  };

  if (cerebrum.defaultProvider === 'openai') {
    nextCerebrum.defaultProvider = OPENAI_CODEX_PROVIDER;
  }

  return { ...config, cerebrum: nextCerebrum };
}

function loadFromEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  const providers: Record<string, unknown> = {};

  for (const [providerId, envVar] of Object.entries(PROVIDER_ENV_VAR_MAP)) {
    const apiKey = process.env[envVar];
    if (apiKey) {
      providers[providerId] = { apiKey };
    }
  }

  if (Object.keys(providers).length > 0) {
    env.cerebrum = { providers };
  }

  return env;
}

export function deepMerge(
  target: Record<string, unknown>,
  ...sources: Record<string, unknown>[]
): Record<string, unknown> {
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof target[key] === 'object' &&
        target[key] !== null &&
        !Array.isArray(target[key])
      ) {
        target[key] = deepMerge(
          { ...(target[key] as Record<string, unknown>) },
          value as Record<string, unknown>,
        );
      } else if (value !== undefined) {
        target[key] = value;
      }
    }
  }
  return target;
}

export function loadConfig(overrides?: Partial<CereWorkerConfig>): CereWorkerConfig {
  ensureConfigDir();

  const globalConfig = loadYaml(existsSync(GLOBAL_CONFIG) ? GLOBAL_CONFIG : GLOBAL_CONFIG_ALT);
  const localPath = resolve(process.cwd(), LOCAL_CONFIG);
  const localConfig = loadYaml(existsSync(localPath) ? localPath : resolve(process.cwd(), LOCAL_CONFIG_ALT));
  const envConfig = loadFromEnv();

  const merged = deepMerge({}, globalConfig, localConfig, envConfig, (overrides ?? {}) as Record<string, unknown>);
  const interpolated = interpolateEnvVars(merged) as Record<string, unknown>;
  const normalized = normalizeLegacyOpenAIOAuthConfig(interpolated);

  return configSchema.parse(normalized);
}

export function loadRawConfig(): Record<string, unknown> {
  return loadYaml(GLOBAL_CONFIG);
}

export { CONFIG_DIR, GLOBAL_CONFIG };
