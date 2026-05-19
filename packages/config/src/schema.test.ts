import { describe, it, expect } from 'vitest';
import { configSchema } from './schema.js';

describe('configSchema', () => {
  describe('defaults', () => {
    it('parses empty object with all defaults', () => {
      const config = configSchema.parse({});
      expect(config.cerebrum.defaultProvider).toBe('anthropic');
      expect(config.cerebrum.defaultModel).toBe('claude-opus-4-7');
      expect(config.cerebrum.maxSteps).toBe(10);
      expect(config.cerebrum.temperature).toBe(0.7);
    });

    it('sets cerebellum defaults', () => {
      const config = configSchema.parse({});
      expect(config.cerebellum.enabled).toBe(true);
      expect(config.cerebellum.address).toBe('localhost:50051');
      expect(config.cerebellum.heartbeatInterval).toBe(30);
      expect(config.cerebellum.model.source).toBe('huggingface');
      expect(config.cerebellum.model.id).toBe('Qwen/Qwen3-0.6B');
    });

    it('sets shell tool defaults', () => {
      const config = configSchema.parse({});
      expect(config.tools.shell.enabled).toBe(true);
      expect(config.tools.shell.denyList).toEqual(['rm -rf /']);
      expect(config.tools.shell.timeout).toBe(30000);
      expect(config.tools.shell.maxOutputSize).toBe(102400);
      expect(config.tools.shell.autoMode).toBe(false);
    });

    it('sets tool runtime defaults', () => {
      const config = configSchema.parse({});
      expect(config.tools.runtime.engine).toBe('enhanced');
      expect(config.tools.runtime.maxResultChars).toBe(20000);
      expect(config.tools.runtime.loopDetection.enabled).toBe(false);
      expect(config.tools.runtime.loopDetection.detectors.genericRepeat).toBe(true);
      expect(config.tools.runtime.loopDetection.detectors.knownPollNoProgress).toBe(true);
      expect(config.tools.runtime.loopDetection.detectors.pingPong).toBe(true);
    });

    it('sets logging defaults', () => {
      const config = configSchema.parse({});
      expect(config.logging.level).toBe('info');
      expect(config.logging.file).toBeUndefined();
    });

    it('sets tui defaults', () => {
      const config = configSchema.parse({});
      expect(config.tui.theme).toBe('auto');
      expect(config.tui.maxDisplayMessages).toBe(100);
      expect(config.tui.showActivity).toBe(true);
    });

    it('sets gateway defaults', () => {
      const config = configSchema.parse({});
      expect(config.gateway.enabled).toBe(false);
      expect(config.gateway.mode).toBe('standalone');
      expect(config.gateway.port).toBe(18800);
    });

    it('sets compaction defaults', () => {
      const config = configSchema.parse({});
      expect(config.cerebrum.compaction.enabled).toBe(true);
      expect(config.cerebrum.compaction.threshold).toBe(0.8);
      expect(config.cerebrum.compaction.keepRecentMessages).toBe(10);
    });

    it('sets finetune defaults', () => {
      const config = configSchema.parse({});
      expect(config.cerebellum.finetune.enabled).toBe(true);
      expect(config.cerebellum.finetune.method).toBe('auto');
      expect(config.cerebellum.finetune.schedule).toBe('auto');
    });
  });

  describe('partial overrides', () => {
    it('fills remaining defaults when partially overridden', () => {
      const config = configSchema.parse({
        cerebrum: { defaultProvider: 'openai' },
      });
      expect(config.cerebrum.defaultProvider).toBe('openai');
      expect(config.cerebrum.defaultModel).toBe('claude-opus-4-7');
      expect(config.cerebrum.maxSteps).toBe(10);
    });

    it('allows overriding nested objects', () => {
      const config = configSchema.parse({
        tools: { shell: { timeout: 60000 } },
      });
      expect(config.tools.shell.timeout).toBe(60000);
      expect(config.tools.shell.enabled).toBe(true);
    });

    it('allows overriding the tool runtime config', () => {
      const config = configSchema.parse({
        tools: {
          runtime: {
            engine: 'enhanced',
            loopDetection: {
              enabled: true,
              criticalThreshold: 5,
            },
          },
        },
      });
      expect(config.tools.runtime.engine).toBe('enhanced');
      expect(config.tools.runtime.loopDetection.enabled).toBe(true);
      expect(config.tools.runtime.loopDetection.criticalThreshold).toBe(5);
      expect(config.tools.runtime.loopDetection.detectors.genericRepeat).toBe(true);
    });

    it('accepts openai-codex as a provider key', () => {
      const config = configSchema.parse({
        cerebrum: {
          providers: {
            'openai-codex': { auth: 'oauth' },
          },
        },
      });
      expect(config.cerebrum.providers['openai-codex']?.auth).toBe('oauth');
    });

    it('accepts the expanded provider keys', () => {
      const config = configSchema.parse({
        cerebrum: {
          providers: {
            openrouter: { apiKey: 'or-key' },
            deepseek: { apiKey: 'ds-key' },
            xai: { apiKey: 'xai-key' },
            mistral: { apiKey: 'mistral-key' },
            together: { apiKey: 'together-key' },
            moonshot: { apiKey: 'moonshot-key', baseUrl: 'https://api.moonshot.cn/v1' },
            minimax: { apiKey: 'minimax-key', baseUrl: 'https://api.minimax.io/anthropic' },
            'minimax-portal': { auth: 'oauth', baseUrl: 'https://api.minimaxi.com/anthropic' },
          },
        },
      });

      expect(config.cerebrum.providers.openrouter?.apiKey).toBe('or-key');
      expect(config.cerebrum.providers.deepseek?.apiKey).toBe('ds-key');
      expect(config.cerebrum.providers.xai?.apiKey).toBe('xai-key');
      expect(config.cerebrum.providers.mistral?.apiKey).toBe('mistral-key');
      expect(config.cerebrum.providers.together?.apiKey).toBe('together-key');
      expect(config.cerebrum.providers.moonshot?.baseUrl).toBe('https://api.moonshot.cn/v1');
      expect(config.cerebrum.providers.minimax?.baseUrl).toBe('https://api.minimax.io/anthropic');
      expect(config.cerebrum.providers['minimax-portal']?.auth).toBe('oauth');
    });

    it('allows overriding channel settings', () => {
      const config = configSchema.parse({
        channels: {
          slack: { enabled: true, botToken: 'xoxb-test' },
          discord: { enabled: true, token: 'discord-token', channelIds: ['123', '456'] },
        },
      });
      expect(config.channels.slack.enabled).toBe(true);
      expect(config.channels.slack.botToken).toBe('xoxb-test');
      expect(config.channels.discord.enabled).toBe(true);
      expect(config.channels.discord.channelIds).toEqual(['123', '456']);
    });

    it('allows overriding tui activity visibility', () => {
      const config = configSchema.parse({
        tui: { showActivity: false },
      });
      expect(config.tui.showActivity).toBe(false);
      expect(config.tui.theme).toBe('auto');
    });

    it('accepts structured task schedules', () => {
      const config = configSchema.parse({
        tasks: [
          {
            id: 'x-update',
            goal: 'Post the nightly X update',
            executionSurface: 'browser',
            schedule: { type: 'daily_at', time: '22:00', timezone: 'America/Los_Angeles' },
          },
          {
            id: 'health-check',
            goal: 'Run routine checks',
            schedule: { type: 'interval', every: 3, unit: 'hours' },
          },
          {
            id: 'migration',
            goal: 'Finish the migration',
            kind: 'one_shot',
            schedule: { type: 'one_shot', dueAt: '2026-04-05T05:00:00Z' },
          },
        ],
      });

      expect(config.tasks[0]?.schedule).toMatchObject({ type: 'daily_at', time: '22:00' });
      expect(config.tasks[0]?.executionSurface).toBe('browser');
      expect(config.tasks[1]?.schedule).toMatchObject({ type: 'interval', every: 3, unit: 'hours' });
      expect(config.tasks[2]?.schedule).toMatchObject({ type: 'one_shot', dueAt: '2026-04-05T05:00:00Z' });
    });
  });

  describe('validation', () => {
    it('rejects invalid logging level', () => {
      const result = configSchema.safeParse({
        logging: { level: 'verbose' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid gateway mode', () => {
      const result = configSchema.safeParse({
        gateway: { mode: 'cluster' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects string where number expected', () => {
      const result = configSchema.safeParse({
        cerebrum: { maxSteps: 'ten' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid finetune method', () => {
      const result = configSchema.safeParse({
        cerebellum: { finetune: { method: 'pruning' } },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid theme', () => {
      const result = configSchema.safeParse({
        tui: { theme: 'solarized' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown runtime engine values', () => {
      const result = configSchema.safeParse({
        tools: {
          runtime: {
            engine: 'invalid-engine',
          },
        },
      });
      expect(result.success).toBe(false);
    });
  });
});
