import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { configSchema, type CereWorkerConfig } from './schema.js';

const CONFIG_DIR = join(homedir(), '.cereworker');
const GLOBAL_CONFIG = join(CONFIG_DIR, 'config.yaml');
const LOCAL_CONFIG = '.cereworker.yaml';

function ensureConfigDir(): void {
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

function loadFromEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY } = process.env;

  if (ANTHROPIC_API_KEY || OPENAI_API_KEY || GOOGLE_API_KEY) {
    const providers: Record<string, unknown> = {};
    if (ANTHROPIC_API_KEY) providers.anthropic = { apiKey: ANTHROPIC_API_KEY };
    if (OPENAI_API_KEY) providers.openai = { apiKey: OPENAI_API_KEY };
    if (GOOGLE_API_KEY) providers.google = { apiKey: GOOGLE_API_KEY };
    env.cerebrum = { providers };
  }

  return env;
}

function deepMerge(
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

  const globalConfig = loadYaml(GLOBAL_CONFIG);
  const localConfig = loadYaml(resolve(process.cwd(), LOCAL_CONFIG));
  const envConfig = loadFromEnv();

  const merged = deepMerge({}, globalConfig, localConfig, envConfig, (overrides ?? {}) as Record<string, unknown>);
  const interpolated = interpolateEnvVars(merged) as Record<string, unknown>;

  return configSchema.parse(interpolated);
}

export { CONFIG_DIR, GLOBAL_CONFIG };
