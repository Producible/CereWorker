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
    expect(config.cerebrum.defaultModel).toBe('claude-opus-4-7');
    expect(config.cerebrum.maxSteps).toBe(10);
    expect(config.cerebrum.temperature).toBe(0.7);
    expect(config.tools.shell.enabled).toBe(true);
    expect(config.tools.shell.denyList).toEqual(['rm -rf /']);
    expect(config.tools.runtime.engine).toBe('enhanced');
    expect(config.logging.level).toBe('info');
    expect(config.tui.showActivity).toBe(true);
    expect(config.conversations.turnJournals.maxDays).toBe(30);
    expect(config.conversations.turnJournals.maxFilesPerConversation).toBe(100);
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
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test-456');
    vi.stubEnv('MINIMAX_API_KEY', 'minimax-test-789');
    const config = loadConfig();
    expect(config.cerebrum.providers.anthropic?.apiKey).toBe('sk-test-123');
    expect(config.cerebrum.providers.openrouter?.apiKey).toBe('or-test-456');
    expect(config.cerebrum.providers.minimax?.apiKey).toBe('minimax-test-789');
  });

  it('normalizes legacy openai OAuth config to openai-codex', () => {
    const config = loadConfig({
      cerebrum: {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.2-codex',
        providers: {
          openai: {
            auth: 'oauth',
          },
        },
        maxSteps: 10,
        temperature: 0.7,
      },
    });

    expect(config.cerebrum.defaultProvider).toBe('openai-codex');
    expect(config.cerebrum.providers['openai-codex']?.auth).toBe('oauth');
    expect(config.cerebrum.providers.openai?.auth).toBe('oauth');
  });

  it('keeps direct openai api-key configs unchanged', () => {
    const config = loadConfig({
      cerebrum: {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.4',
        providers: {
          openai: {
            apiKey: 'sk-test',
          },
        },
        maxSteps: 10,
        temperature: 0.7,
      },
    });

    expect(config.cerebrum.defaultProvider).toBe('openai');
    expect(config.cerebrum.providers['openai-codex']).toBeUndefined();
    expect(config.cerebrum.providers.openai?.apiKey).toBe('sk-test');
  });

  it('cerebellum defaults are correct', () => {
    const config = loadConfig();
    expect(config.cerebellum.enabled).toBe(true);
    expect(config.cerebellum.address).toBe('localhost:50051');
    expect(config.cerebellum.model.id).toBe('Qwen/Qwen3-0.6B');
  });

  it('loads tool runtime overrides', () => {
    const config = loadConfig({
      tools: {
        runtime: {
          engine: 'enhanced',
          maxResultChars: 4096,
          loopDetection: {
            enabled: true,
            warningThreshold: 3,
            criticalThreshold: 4,
            historySize: 12,
            globalCircuitBreakerThreshold: 16,
            detectors: {
              genericRepeat: true,
              knownPollNoProgress: false,
              pingPong: true,
            },
          },
        },
      },
    });

    expect(config.tools.runtime.engine).toBe('enhanced');
    expect(config.tools.runtime.maxResultChars).toBe(4096);
    expect(config.tools.runtime.loopDetection.enabled).toBe(true);
    expect(config.tools.runtime.loopDetection.warningThreshold).toBe(3);
    expect(config.tools.runtime.loopDetection.detectors.knownPollNoProgress).toBe(false);
  });

  it('rejects unknown runtime engine values', () => {
    expect(() => loadConfig({
      tools: {
        runtime: {
          engine: 'invalid-engine' as 'enhanced',
        },
      },
    })).toThrow();
  });

  it('sub-agent defaults are correct', () => {
    const config = loadConfig();
    expect(config.subAgents.enabled).toBe(true);
    expect(config.subAgents.maxConcurrent).toBe(5);
    expect(config.subAgents.defaultTimeoutMinutes).toBe(5);
  });

  it('loads tui activity visibility overrides', () => {
    const config = loadConfig({
      tui: {
        showActivity: false,
      },
    });

    expect(config.tui.showActivity).toBe(false);
    expect(config.tui.theme).toBe('auto');
  });

  it('loads turn journal retention overrides', () => {
    const config = loadConfig({
      conversations: {
        turnJournals: {
          maxDays: 14,
          maxFilesPerConversation: 50,
        },
      },
    });

    expect(config.conversations.turnJournals.maxDays).toBe(14);
    expect(config.conversations.turnJournals.maxFilesPerConversation).toBe(50);
  });
});
