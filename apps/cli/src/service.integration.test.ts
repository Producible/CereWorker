import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type CereWorkerConfig } from '@cereworker/config';
import type { CerebellumAdapter } from '@cereworker/core';
import type { ChannelPlugin, MessageHandler, InboundMessage } from '@cereworker/channels';
import { createService } from './service.js';
import { buildChannelConversationKey } from './channel-conversations.js';

function makeConfig(overrides: Record<string, unknown> = {}): CereWorkerConfig {
  return configSchema.parse({
    cerebrum: {
      defaultProvider: 'local',
      defaultModel: 'llama3.3',
      providers: {
        local: {
          baseUrl: 'http://127.0.0.1:11434',
          model: 'llama3.3',
        },
      },
      streamStallThreshold: 1,
      maxNudgeRetries: 1,
    },
    cerebellum: {
      enabled: false,
      verification: { enabled: false },
      finetune: { enabled: false },
    },
    hippocampus: { enabled: false },
    proactive: { enabled: false },
    subAgents: { enabled: false },
    tools: {
      shell: { enabled: false },
      fileOps: { enabled: false },
      http: { enabled: false },
      web: { enabled: false },
      browser: { enabled: false },
    },
    channels: { dmPolicy: 'open' },
    ...overrides,
  });
}

function createWatchdogCerebellum(): CerebellumAdapter {
  return {
    isConnected: vi.fn(() => true),
    verifyToolResult: vi.fn(async () => ({ passed: false, checks: [], modelVerdict: false })),
    ingestTrainingData: vi.fn(async () => 0),
    startFineTune: vi.fn(async () => ({ jobId: '', started: false, error: '' })),
    getFineTuneStatus: vi.fn(async () => null),
  };
}

describe('createService integration', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cereworker-service-'));
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('retries a stalled stream through the real service bridge without surfacing a false error', async () => {
    vi.useFakeTimers();

    const service = createService(makeConfig());
    const cerebellum = createWatchdogCerebellum();
    service.orchestrator.setCerebellum(cerebellum, { enabled: false });

    let attempts = 0;
    service.cerebrum.stream = vi.fn(async (_messages, _tools, callbacks, options) => {
      attempts++;
      if (attempts === 1) {
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) {
            reject(new Error('missing abort signal'));
            return;
          }
          const onAbort = () => {
            callbacks.onError(new Error('intentional nudge abort'));
            reject(new Error('intentional nudge abort'));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
        return;
      }

      callbacks.onChunk('Recovered reply');
      callbacks.onFinish('Recovered reply');
    });

    const errors: Error[] = [];
    const nudges: number[] = [];
    service.orchestrator.on('error', ({ error }) => errors.push(error));
    service.orchestrator.on('cerebrum:stall:nudge', ({ attempt }) => nudges.push(attempt));

    const sendPromise = service.orchestrator.sendMessage('hello from watchdog');
    await vi.advanceTimersByTimeAsync(15_000);
    await sendPromise;

    const messages = service.orchestrator.getMessages();
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
    expect(nudges).toEqual([1]);
    expect(messages.slice(-3).map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello from watchdog'],
      ['system', '[Cerebellum] You stopped mid-response. Continue from where you left off.'],
      ['cerebrum', 'Recovered reply'],
    ]);

    await service.shutdown();
  });

  it('keeps short-term channel conversations separate while persisting the session map', async () => {
    const service = createService(makeConfig());
    service.cerebrum.stream = vi.fn(async (messages, _tools, callbacks) => {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      callbacks.onFinish(`reply:${lastUser?.content ?? ''}`);
    });

    let inboundHandler: MessageHandler | null = null;
    let connected = false;
    const fakeChannel: ChannelPlugin = {
      id: 'discord',
      meta: { name: 'Discord', emoji: '💬' },
      start: vi.fn(async (handler) => {
        inboundHandler = handler;
        connected = true;
      }),
      stop: vi.fn(async () => {
        connected = false;
      }),
      send: vi.fn(async () => {}),
      isAllowed: vi.fn(() => true),
      isConnected: vi.fn(() => connected),
    };

    service.channelManager.register(fakeChannel);
    await service.startChannels();

    expect(inboundHandler).not.toBeNull();

    const messageA1: InboundMessage = {
      channelId: 'discord',
      senderId: 'user-a',
      senderName: 'Alice',
      sessionId: 'dm:user-a',
      text: 'hello from a',
      timestamp: Date.now(),
    };
    const messageB1: InboundMessage = {
      channelId: 'discord',
      senderId: 'user-b',
      senderName: 'Bob',
      sessionId: 'dm:user-b',
      text: 'hello from b',
      timestamp: Date.now() + 1,
    };
    const messageA2: InboundMessage = {
      ...messageA1,
      text: 'follow up from a',
      timestamp: Date.now() + 2,
    };

    await expect(inboundHandler!(messageA1)).resolves.toBe('reply:hello from a');
    await expect(inboundHandler!(messageB1)).resolves.toBe('reply:hello from b');
    await expect(inboundHandler!(messageA2)).resolves.toBe('reply:follow up from a');

    const mapPath = join(homeDir, '.cereworker', 'channel-conversations.json');
    const savedMap = JSON.parse(readFileSync(mapPath, 'utf-8')) as Record<string, string>;
    const keyA = buildChannelConversationKey(messageA1);
    const keyB = buildChannelConversationKey(messageB1);

    expect(savedMap[keyA]).toBeTruthy();
    expect(savedMap[keyB]).toBeTruthy();
    expect(savedMap[keyA]).not.toBe(savedMap[keyB]);

    const conversationStore = service.orchestrator.getConversationStore();
    const conversationA = conversationStore.get(savedMap[keyA]);
    const conversationB = conversationStore.get(savedMap[keyB]);

    expect(conversationA?.messages.map((message) => message.content)).toEqual([
      'hello from a',
      'reply:hello from a',
      'follow up from a',
      'reply:follow up from a',
    ]);
    expect(conversationB?.messages.map((message) => message.content)).toEqual([
      'hello from b',
      'reply:hello from b',
    ]);

    await service.shutdown();
  });
});
