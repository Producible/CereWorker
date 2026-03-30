import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    // Failed attempt messages cleaned up on success — only user + final cerebrum remain
    expect(messages.slice(-2).map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello from watchdog'],
      ['cerebrum', 'Recovered reply'],
    ]);

    await service.shutdown();
  });

  it('uses the configured home directory for persisted service state', async () => {
    const homeOne = join(homeDir, 'one');
    const homeTwo = join(homeDir, 'two');
    mkdirSync(homeOne, { recursive: true });
    mkdirSync(homeTwo, { recursive: true });

    const firstService = createService(makeConfig(), { homeDir: () => homeOne });
    const firstConversationId = firstService.orchestrator.startConversation();
    expect(firstService.orchestrator.getConversation(firstConversationId)).toBeDefined();
    await firstService.shutdown();

    const secondService = createService(makeConfig(), { homeDir: () => homeTwo });
    expect(secondService.orchestrator.getConversation(firstConversationId)).toBeUndefined();
    await secondService.shutdown();
  });

  it('retries when a streamed tool call hangs until the watchdog aborts it', async () => {
    vi.useFakeTimers();

    const service = createService(makeConfig());
    const cerebellum = createWatchdogCerebellum();
    service.orchestrator.setCerebellum(cerebellum, { enabled: false });
    service.orchestrator.registerTool('hangTool', {
      description: 'hang forever',
      parameters: {},
      execute: async (_args, context) => {
        const abortSignal = context?.abortSignal;
        if (!abortSignal) {
          throw new Error('missing abort signal');
        }

        return await new Promise<string>((_resolve, reject) => {
          const onAbort = () => {
            const error = new Error('Tool execution aborted');
            error.name = 'AbortError';
            reject(error);
          };

          if (abortSignal.aborted) {
            onAbort();
            return;
          }

          abortSignal.addEventListener('abort', onAbort, { once: true });
        });
      },
    });

    let attempts = 0;
    service.cerebrum.stream = vi.fn(async (_messages, _tools, callbacks, options) => {
      attempts++;
      if (attempts === 1) {
        await callbacks.onToolCall({ id: 'tool-1', name: 'hangTool', args: {} });
        return;
      }

      callbacks.onChunk('Recovered reply');
      callbacks.onFinish('Recovered reply');
    });

    const errors: Error[] = [];
    const nudges: number[] = [];
    const systemMessages: string[] = [];
    service.orchestrator.on('error', ({ error }) => errors.push(error));
    service.orchestrator.on('cerebrum:stall:nudge', ({ attempt }) => nudges.push(attempt));
    service.orchestrator.on('message:system', ({ message }) => systemMessages.push(message.content));

    const sendPromise = service.orchestrator.sendMessage('hello from hung tool');
    await vi.advanceTimersByTimeAsync(15_000);
    await sendPromise;

    const messages = service.orchestrator.getMessages();
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
    expect(nudges).toEqual([1]);
    expect(systemMessages).toEqual([
      '[Cerebellum] You stopped mid-response. Continue from where you left off.',
    ]);
    // Failed attempt messages cleaned up on success
    expect(messages.at(-1)).toMatchObject({
      role: 'cerebrum',
      content: 'Recovered reply',
    });
    expect(messages.some((message) => message.role === 'tool')).toBe(false);

    await service.shutdown();
  });

  it('continues retrying when the aborted stream never settles after the watchdog fires', async () => {
    vi.useFakeTimers();

    const service = createService(makeConfig());
    const cerebellum = createWatchdogCerebellum();
    service.orchestrator.setCerebellum(cerebellum, { enabled: false });

    let attempts = 0;
    service.cerebrum.stream = vi.fn(async (_messages, _tools, callbacks, options) => {
      attempts++;
      if (attempts === 1) {
        await new Promise<void>(() => {
          const signal = options?.abortSignal;
          if (!signal) {
            throw new Error('missing abort signal');
          }

          signal.addEventListener('abort', () => {
            // Intentionally never resolve or reject to simulate a provider teardown hang.
          }, { once: true });
        });
        return;
      }

      callbacks.onChunk('Recovered after hung teardown');
      callbacks.onFinish('Recovered after hung teardown');
    });

    const stages: string[] = [];
    const messages: string[] = [];
    service.orchestrator.on('cerebrum:watchdog', ({ stage, message }) => {
      stages.push(stage);
      messages.push(message);
    });

    const sendPromise = service.orchestrator.sendMessage('hello from hung teardown');
    await vi.advanceTimersByTimeAsync(16_000);
    await sendPromise;

    expect(attempts).toBe(2);
    expect(stages).toEqual([
      'stalled',
      'nudge_requested',
      'abort_issued',
      'teardown_timeout',
      'retry_started',
      'retry_recovered',
    ]);
    expect(messages).toContain(
      'Provider did not settle within 1000ms after abort; continuing retry.',
    );
    expect(service.orchestrator.getMessages().at(-1)).toMatchObject({
      role: 'cerebrum',
      content: 'Recovered after hung teardown',
    });

    await service.shutdown();
  });

  it('retries a tool-driven turn that finishes without a completion signal', async () => {
    const service = createService(makeConfig());
    service.orchestrator.startConversation();
    service.orchestrator.registerTool('workTool', {
      description: 'perform work',
      parameters: {},
      execute: async () => 'verified work result',
    });

    const attemptInputs: Array<Array<{ role: string; content: string; source?: unknown }>> = [];
    let attempts = 0;
    service.cerebrum.stream = vi.fn(async (messages, _tools, callbacks) => {
      attemptInputs.push(messages.map((message: { role: string; content: string; metadata?: Record<string, unknown> }) => ({
        role: message.role,
        content: message.content,
        source: message.metadata?.source,
      })));
      attempts++;

      if (attempts === 1) {
        await callbacks.onToolCall({ id: 'tool-1', name: 'workTool', args: {} });
        callbacks.onChunk('I already reviewed the profile and just need to finalize the response.');
        callbacks.onFinish(
          '',
          [{ id: 'tool-1', name: 'workTool', args: {} }],
          {
            finishReason: 'tool-calls',
            rawFinishReason: 'tool_calls',
            stepFinishReasons: ['tool-calls'],
            chunkCount: 1,
            textChars: 0,
            toolCallCount: 1,
            hadToolActivity: true,
            stepCount: 1,
          },
        );
        return;
      }

      await callbacks.onToolCall({ id: 'tool-2', name: 'workTool', args: {} });
      await callbacks.onToolCall({
        id: 'sig-1',
        name: 'task_complete',
        args: { summary: 'done', evidence: 'Observed verified work result.' },
      });
      callbacks.onChunk('Completed with evidence.');
      callbacks.onFinish(
        'Completed with evidence.',
        [
          { id: 'tool-2', name: 'workTool', args: {} },
          { id: 'sig-1', name: 'task_complete', args: { summary: 'done', evidence: 'Observed verified work result.' } },
        ],
        {
          finishReason: 'stop',
          rawFinishReason: 'stop',
          stepFinishReasons: ['tool-calls', 'stop'],
          chunkCount: 3,
          textChars: 'Completed with evidence.'.length,
          toolCallCount: 2,
          hadToolActivity: true,
          stepCount: 2,
        },
      );
    });

    const completionStages: string[] = [];
    service.orchestrator.on('cerebrum:completion', ({ stage }) => completionStages.push(stage));

    await service.orchestrator.sendMessage('finish the task');

    expect(attempts).toBe(2);
    const completionResumeMessage = attemptInputs[1]?.find((message) =>
      message.content.startsWith('[Completion resume context]'));
    expect(completionResumeMessage).toBeDefined();
    expect(completionResumeMessage?.content).toContain('verified work result');
    expect(completionResumeMessage?.content).toContain('I already reviewed the profile and just need to finalize the response.');
    expect(completionStages).toEqual([
      'guard_triggered',
      'retry_started',
      'signal_recorded',
      'retry_recovered',
    ]);
    // Failed attempt messages cleaned up on success — only user + final cerebrum remain
    expect(service.orchestrator.getMessages().map((message) => [message.role, message.content])).toEqual([
      ['user', 'finish the task'],
      ['cerebrum', 'Completed with evidence.'],
    ]);
    expect(service.orchestrator.getMessages().some((message) => message.metadata?.source === 'completion-resume')).toBe(false);

    await service.shutdown();
  });

  it('keeps stall retries and completion retries independent across a mixed recovery path', async () => {
    vi.useFakeTimers();

    const service = createService(makeConfig());
    service.orchestrator.startConversation();
    const cerebellum = createWatchdogCerebellum();
    service.orchestrator.setCerebellum(cerebellum, { enabled: false });
    service.orchestrator.registerTool('workTool', {
      description: 'perform work',
      parameters: {},
      execute: async () => 'verified work result',
    });

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

      if (attempts === 2) {
        await callbacks.onToolCall({ id: 'tool-1', name: 'workTool', args: {} });
        callbacks.onFinish(
          '',
          [{ id: 'tool-1', name: 'workTool', args: {} }],
          {
            finishReason: 'tool-calls',
            rawFinishReason: 'tool_calls',
            stepFinishReasons: ['tool-calls'],
            chunkCount: 1,
            textChars: 0,
            toolCallCount: 1,
            hadToolActivity: true,
            stepCount: 1,
          },
        );
        return;
      }

      await callbacks.onToolCall({ id: 'tool-2', name: 'workTool', args: {} });
      await callbacks.onToolCall({
        id: 'sig-1',
        name: 'task_complete',
        args: { summary: 'done', evidence: 'Observed verified work result.' },
      });
      callbacks.onFinish(
        'Completed after mixed retries.',
        [
          { id: 'tool-2', name: 'workTool', args: {} },
          { id: 'sig-1', name: 'task_complete', args: { summary: 'done', evidence: 'Observed verified work result.' } },
        ],
        {
          finishReason: 'stop',
          rawFinishReason: 'stop',
          stepFinishReasons: ['tool-calls', 'stop'],
          chunkCount: 2,
          textChars: 'Completed after mixed retries.'.length,
          toolCallCount: 2,
          hadToolActivity: true,
          stepCount: 2,
        },
      );
    });

    const watchdogStages: string[] = [];
    const completionStages: string[] = [];
    service.orchestrator.on('cerebrum:watchdog', ({ stage }) => watchdogStages.push(stage));
    service.orchestrator.on('cerebrum:completion', ({ stage }) => completionStages.push(stage));

    const sendPromise = service.orchestrator.sendMessage('finish the task');
    await vi.advanceTimersByTimeAsync(15_000);
    await sendPromise;

    expect(attempts).toBe(3);
    expect(watchdogStages).toEqual([
      'stalled',
      'nudge_requested',
      'abort_issued',
      'retry_started',
    ]);
    expect(completionStages).toEqual([
      'guard_triggered',
      'retry_started',
      'signal_recorded',
      'retry_recovered',
    ]);
    // Failed attempt messages cleaned up on success — only user + final cerebrum remain
    expect(service.orchestrator.getMessages().map((message) => [message.role, message.content])).toEqual([
      ['user', 'finish the task'],
      ['cerebrum', 'Completed after mixed retries.'],
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
