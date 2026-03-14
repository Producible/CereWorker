import { describe, it, expect, vi, afterEach } from 'vitest';
import { deepMerge, loadConfig } from './loader.js';

describe('deepMerge', () => {
  it('merges flat objects', () => {
    expect(deepMerge({}, { a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('overrides scalar values', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('deep merges nested objects', () => {
    const result = deepMerge(
      { nested: { a: 1, b: 2 } },
      { nested: { b: 3, c: 4 } },
    );
    expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
  });

  it('replaces arrays instead of merging', () => {
    expect(deepMerge({ arr: [1, 2] }, { arr: [3] })).toEqual({ arr: [3] });
  });

  it('does not merge null or undefined values', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('handles empty sources', () => {
    expect(deepMerge({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns valid config with all defaults', () => {
    const config = loadConfig();
    expect(config.cerebrum.defaultProvider).toBe('anthropic');
    expect(config.cerebrum.defaultModel).toBe('claude-sonnet-4-6');
    expect(config.cerebrum.maxSteps).toBe(10);
    expect(config.cerebrum.temperature).toBe(0.7);
    expect(config.tools.shell.enabled).toBe(true);
    expect(config.tools.shell.denyList).toEqual(['rm -rf /']);
    expect(config.logging.level).toBe('info');
  });

  it('applies overrides', () => {
    const config = loadConfig({
      cerebrum: {
        defaultProvider: 'openai',
        defaultModel: 'gpt-4o',
        providers: {},
        maxSteps: 20,
        temperature: 0.5,
      },
    });
    expect(config.cerebrum.defaultProvider).toBe('openai');
    expect(config.cerebrum.defaultModel).toBe('gpt-4o');
    expect(config.cerebrum.maxSteps).toBe(20);
  });

  it('picks up API keys from env vars', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-123');
    const config = loadConfig();
    expect(config.cerebrum.providers.anthropic?.apiKey).toBe('sk-test-123');
  });

  it('cerebellum defaults are correct', () => {
    const config = loadConfig();
    expect(config.cerebellum.enabled).toBe(true);
    expect(config.cerebellum.address).toBe('localhost:50051');
    expect(config.cerebellum.model.id).toBe('Qwen/Qwen3-0.6B');
  });

  it('sub-agent defaults are correct', () => {
    const config = loadConfig();
    expect(config.subAgents.enabled).toBe(true);
    expect(config.subAgents.maxConcurrent).toBe(5);
    expect(config.subAgents.defaultTimeoutMinutes).toBe(5);
  });
});
