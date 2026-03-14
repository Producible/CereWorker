import { describe, it, expect } from 'vitest';
import { configSchema } from './schema.js';

describe('configSchema', () => {
  describe('defaults', () => {
    it('parses empty object with all defaults', () => {
      const config = configSchema.parse({});
      expect(config.cerebrum.defaultProvider).toBe('anthropic');
      expect(config.cerebrum.defaultModel).toBe('claude-sonnet-4-6');
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

    it('sets logging defaults', () => {
      const config = configSchema.parse({});
      expect(config.logging.level).toBe('info');
      expect(config.logging.file).toBeUndefined();
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
      expect(config.cerebrum.defaultModel).toBe('claude-sonnet-4-6');
      expect(config.cerebrum.maxSteps).toBe(10);
    });

    it('allows overriding nested objects', () => {
      const config = configSchema.parse({
        tools: { shell: { timeout: 60000 } },
      });
      expect(config.tools.shell.timeout).toBe(60000);
      expect(config.tools.shell.enabled).toBe(true);
    });

    it('allows overriding channel settings', () => {
      const config = configSchema.parse({
        channels: { slack: { enabled: true, botToken: 'xoxb-test' } },
      });
      expect(config.channels.slack.enabled).toBe(true);
      expect(config.channels.slack.botToken).toBe('xoxb-test');
      expect(config.channels.discord.enabled).toBe(false);
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
  });
});
