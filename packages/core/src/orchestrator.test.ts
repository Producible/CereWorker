import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { CerebrumAdapter, CerebellumAdapter, ToolDefinition } from './orchestrator.js';
import { ConversationStore } from './conversation.js';
import type { Message, StreamFinishMetadata } from './types.js';

function createMockCerebrum(): CerebrumAdapter {
  return {
    stream: vi.fn(async (_msgs, _tools, cb) => {
      cb.onChunk('hello');
      cb.onFinish('hello');
    }),
    summarize: vi.fn(async () => 'summary'),
  };
}

function createMockCerebellum(): CerebellumAdapter {
  return {
    isConnected: vi.fn(() => true),
    verifyToolResult: vi.fn(async () => ({ passed: true, checks: [], modelVerdict: true })),
    ingestTrainingData: vi.fn(async () => 5),
    startFineTune: vi.fn(async () => ({ jobId: 'ft-1', started: true, error: '' })),
    getFineTuneStatus: vi.fn(async () => null),
  };
}

function createTestTool(output = 'ok'): ToolDefinition {
  return {
    description: 'test tool',
    parameters: {},
    execute: vi.fn(async () => output),
  };
}

function createStructuredTool(
  output: string,
  resume: Record<string, unknown>,
): ToolDefinition {
  return {
    description: 'structured test tool',
    parameters: {},
    execute: vi.fn(async () => ({
      output,
      metadata: {
        resume,
      },
    })),
  };
}

function makeFinishMeta(overrides: Partial<StreamFinishMetadata> = {}): StreamFinishMetadata {
  return {
    finishReason: 'stop',
    rawFinishReason: 'stop',
    stepFinishReasons: ['stop'],
    chunkCount: 1,
    textChars: 4,
    toolCallCount: 0,
    hadToolActivity: false,
    stepCount: 1,
    ...overrides,
  };
}

describe('Orchestrator', () => {
  let orch: Orchestrator;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  afterEach(async () => {
    await orch.stop();
  });

  // --- Constructor & options ---

  describe('constructor', () => {
    it('creates with default options', () => {
      expect(orch.getActiveConversationId()).toBeNull();
      expect(orch.getAutoMode()).toBe(false);
    });

    it('accepts custom conversation store', () => {
      const store = new ConversationStore();
      const conv = store.create();
      store.appendMessage(conv.id, 'user', 'hi');
      const o = new Orchestrator({ conversationStore: store });
      expect(o.getMessages(conv.id)).toHaveLength(1);
    });

    it('accepts custom compaction config', () => {
      // Compaction config is internal but we verify it doesn't throw
      const o = new Orchestrator({ compaction: { threshold: 0.5, contextWindow: 64000 } });
      expect(o).toBeInstanceOf(Orchestrator);
    });
  });

  // --- System context ---

  describe('system context', () => {
    it('returns null by default', () => {
      expect(orch.getSystemContext()).toBeNull();
    });

    it('stores and retrieves system context', () => {
      orch.setSystemContext('skills prompt');
      expect(orch.getSystemContext()).toBe('skills prompt');
    });

    it('overwrites previous context', () => {
      orch.setSystemContext('first');
      orch.setSystemContext('second');
      expect(orch.getSystemContext()).toBe('second');
    });
  });

  // --- Tool management ---

  describe('tool management', () => {
    it('registerTool makes tool available', () => {
      const tool = createTestTool();
      orch.registerTool('greet', tool);
      // Tool is used internally during sendMessage, verify it was registered
      // by checking unregister succeeds
      expect(orch.unregisterTool('greet')).toBe(true);
    });

    it('registerTools registers multiple tools', () => {
      orch.registerTools({
        tool_a: createTestTool(),
        tool_b: createTestTool(),
      });
      expect(orch.unregisterTool('tool_a')).toBe(true);
      expect(orch.unregisterTool('tool_b')).toBe(true);
    });

    it('unregisterTool returns false for non-existent tool', () => {
      expect(orch.unregisterTool('nonexistent')).toBe(false);
    });

    it('unregisterTool removes the tool', () => {
      orch.registerTool('temp', createTestTool());
      expect(orch.unregisterTool('temp')).toBe(true);
      expect(orch.unregisterTool('temp')).toBe(false);
    });
  });

  // --- Auto mode ---

  describe('auto mode', () => {
    it('defaults to false', () => {
      expect(orch.getAutoMode()).toBe(false);
    });

    it('setAutoMode changes the value', () => {
      orch.setAutoMode(true);
      expect(orch.getAutoMode()).toBe(true);
    });

    it('can toggle back to false', () => {
      orch.setAutoMode(true);
      orch.setAutoMode(false);
      expect(orch.getAutoMode()).toBe(false);
    });
  });

  // --- Gateway mode ---

  describe('gateway mode', () => {
    it('setGatewayMode sets mode to gateway with node count', () => {
      // No getter, but verify it doesn't throw and is used in system prompt
      orch.setGatewayMode('gateway', { connectedNodes: 3 });
    });

    it('setGatewayMode sets mode to node with URL', () => {
      orch.setGatewayMode('node', { gatewayUrl: 'ws://hub:18800' });
    });

    it('setGatewayMode sets standalone', () => {
      orch.setGatewayMode('standalone');
    });
  });

  // --- Conversation lifecycle ---

  describe('conversation lifecycle', () => {
    it('startConversation returns an id', () => {
      const id = orch.startConversation();
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('getActiveConversationId returns the started conversation', () => {
      const id = orch.startConversation();
      expect(orch.getActiveConversationId()).toBe(id);
    });

    it('getMessages returns empty array for new conversation', () => {
      orch.startConversation();
      expect(orch.getMessages()).toEqual([]);
    });

    it('getMessages returns empty array with no active conversation', () => {
      expect(orch.getMessages()).toEqual([]);
    });

    it('resumeConversation restores existing conversation', () => {
      const id = orch.startConversation();
      orch.startConversation(); // start a new one
      expect(orch.resumeConversation(id)).toBe(true);
      expect(orch.getActiveConversationId()).toBe(id);
    });

    it('resumeConversation returns false for non-existent id', () => {
      expect(orch.resumeConversation('nonexistent')).toBe(false);
    });

    it('resumeConversation emits conversation:resumed event', () => {
      const id = orch.startConversation();
      const handler = vi.fn();
      orch.on('conversation:resumed', handler);
      orch.resumeConversation(id);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'conversation:resumed',
          conversationId: id,
          messages: [],
        }),
      );
    });

    it('getConversationStore returns the store', () => {
      const store = orch.getConversationStore();
      expect(store).toBeInstanceOf(ConversationStore);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('throws without cerebrum', async () => {
      orch.startConversation();
      await expect(orch.sendMessage('hi')).rejects.toThrow('Cerebrum not connected');
    });

    it('throws without active conversation', async () => {
      orch.setCerebrum(createMockCerebrum());
      await expect(orch.sendMessage('hi')).rejects.toThrow('No active conversation');
    });

    it('emits message:user event', async () => {
      const cerebrum = createMockCerebrum();
      orch.setCerebrum(cerebrum);
      orch.startConversation();

      const handler = vi.fn();
      orch.on('message:user', handler);
      await orch.sendMessage('hello');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'message:user' }),
      );
      expect(handler.mock.calls[0][0].message.content).toBe('hello');
    });

    it('emits message:cerebrum:start and message:cerebrum:end', async () => {
      orch.setCerebrum(createMockCerebrum());
      orch.startConversation();

      const startHandler = vi.fn();
      const endHandler = vi.fn();
      orch.on('message:cerebrum:start', startHandler);
      orch.on('message:cerebrum:end', endHandler);

      await orch.sendMessage('hi');

      expect(startHandler).toHaveBeenCalledOnce();
      expect(endHandler).toHaveBeenCalledOnce();
      expect(endHandler.mock.calls[0][0].message.content).toBe('hello');
    });

    it('stores messages in conversation', async () => {
      orch.setCerebrum(createMockCerebrum());
      orch.startConversation();
      await orch.sendMessage('hi');
      const messages = orch.getMessages();
      expect(messages).toHaveLength(2); // user + cerebrum
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('cerebrum');
    });

    it('retries a tool-driven turn that ends without a completion signal', async () => {
      orch.registerTool('workTool', createTestTool('worked'));
      const cerebrum: CerebrumAdapter = {
        stream: vi.fn(async (_messages, _tools, callbacks) => {
          callbacks.onToolCall({ id: 'tool-1', name: 'workTool', args: {} });
          callbacks.onFinish('', [{ id: 'tool-1', name: 'workTool', args: {} }], makeFinishMeta({
            finishReason: 'tool-calls',
            rawFinishReason: 'tool_calls',
            stepFinishReasons: ['tool-calls'],
            toolCallCount: 1,
            hadToolActivity: true,
            textChars: 0,
          }));
        })
          .mockImplementationOnce(async (_messages, _tools, callbacks) => {
            await callbacks.onToolCall({ id: 'tool-1', name: 'workTool', args: {} });
            callbacks.onFinish('', [{ id: 'tool-1', name: 'workTool', args: {} }], makeFinishMeta({
              finishReason: 'tool-calls',
              rawFinishReason: 'tool_calls',
              stepFinishReasons: ['tool-calls'],
              toolCallCount: 1,
              hadToolActivity: true,
              textChars: 0,
            }));
          })
          .mockImplementationOnce(async (_messages, _tools, callbacks) => {
            await callbacks.onToolCall({ id: 'tool-2', name: 'workTool', args: {} });
            await callbacks.onToolCall({
              id: 'sig-1',
              name: 'task_complete',
              args: { summary: 'done', evidence: 'Observed the expected result.' },
            });
            callbacks.onFinish(
              'Completed the task.',
              [
                { id: 'tool-2', name: 'workTool', args: {} },
                { id: 'sig-1', name: 'task_complete', args: { summary: 'done', evidence: 'Observed the expected result.' } },
              ],
              makeFinishMeta({
                finishReason: 'stop',
                rawFinishReason: 'stop',
                stepFinishReasons: ['tool-calls', 'stop'],
                toolCallCount: 2,
                hadToolActivity: true,
                textChars: 'Completed the task.'.length,
                stepCount: 2,
              }),
            );
          }),
        summarize: vi.fn(async () => 'summary'),
      };
      orch.setCerebrum(cerebrum);
      orch.startConversation();

      await orch.sendMessage('finish the task');

      const messages = orch.getMessages();
      expect(messages.filter((message) => message.role === 'cerebrum')).toEqual([
        expect.objectContaining({ content: 'Completed the task.' }),
      ]);
      expect(messages.some((message) => message.role === 'cerebrum' && message.content.trim().length === 0)).toBe(false);
      // Failed attempt tool messages are cleaned up; successful retry's tool results are preserved
      const toolMessages = messages.filter((message) => message.role === 'tool');
      expect(toolMessages).toHaveLength(1); // Only the successful retry's tool result
      expect(toolMessages[0].content).toBe('worked');
    });

    it('accepts task_blocked as a valid terminal signal', async () => {
      orch.registerTool('workTool', createTestTool('login required'));
      const cerebrum: CerebrumAdapter = {
        stream: vi.fn(async (_messages, _tools, callbacks) => {
          await callbacks.onToolCall({ id: 'tool-1', name: 'workTool', args: {} });
          await callbacks.onToolCall({
            id: 'sig-1',
            name: 'task_blocked',
            args: { blocker: 'Login required', evidence: 'The site requires authentication.' },
          });
          callbacks.onFinish(
            'Blocked: the site requires authentication before I can continue.',
            [
              { id: 'tool-1', name: 'workTool', args: {} },
              { id: 'sig-1', name: 'task_blocked', args: { blocker: 'Login required', evidence: 'The site requires authentication.' } },
            ],
            makeFinishMeta({
              finishReason: 'stop',
              rawFinishReason: 'stop',
              stepFinishReasons: ['tool-calls', 'stop'],
              toolCallCount: 2,
              hadToolActivity: true,
              textChars: 'Blocked: the site requires authentication before I can continue.'.length,
              stepCount: 2,
            }),
          );
        }),
        summarize: vi.fn(async () => 'summary'),
      };
      orch.setCerebrum(cerebrum);
      orch.startConversation();

      await orch.sendMessage('finish the task');

      const messages = orch.getMessages();
      expect(cerebrum.stream).toHaveBeenCalledOnce();
      expect(messages.at(-1)).toMatchObject({
        role: 'cerebrum',
        content: 'Blocked: the site requires authentication before I can continue.',
      });
      expect(messages.some((message) => message.role === 'system' && message.content.includes('task_complete or task_blocked'))).toBe(false);
    });

    it('exhausts completion retries without consuming watchdog retries', async () => {
      const localOrch = new Orchestrator({ maxNudgeRetries: 1 });
      try {
        localOrch.registerTool('workTool', createTestTool('worked'));
        const cerebrum: CerebrumAdapter = {
          stream: vi.fn(async (_messages, _tools, callbacks) => {
            const callId = `tool-${Math.random().toString(36).slice(2, 8)}`;
            await callbacks.onToolCall({ id: callId, name: 'workTool', args: {} });
            callbacks.onFinish('', [{ id: callId, name: 'workTool', args: {} }], makeFinishMeta({
              finishReason: 'tool-calls',
              rawFinishReason: 'tool_calls',
              stepFinishReasons: ['tool-calls'],
              toolCallCount: 1,
              hadToolActivity: true,
              textChars: 0,
            }));
          }),
          summarize: vi.fn(async () => 'summary'),
        };
        localOrch.setCerebrum(cerebrum);
        localOrch.startConversation();

        const completionStages: string[] = [];
        const watchdogStages: string[] = [];
        const errors: Error[] = [];
        localOrch.on('cerebrum:completion', ({ stage }) => completionStages.push(stage));
        localOrch.on('cerebrum:watchdog', ({ stage }) => watchdogStages.push(stage));
        localOrch.on('error', ({ error }) => errors.push(error));

        await localOrch.sendMessage('finish the task');

        expect(cerebrum.stream).toHaveBeenCalledTimes(2);
        expect(completionStages).toEqual([
          'guard_triggered',
          'retry_started',
          'guard_triggered',
          'retry_failed',
        ]);
        expect(watchdogStages).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toBe('Turn ended without a valid completion signal or final answer.');
        // Failed attempt messages are cleaned up — only user + diagnostic remain
        expect(localOrch.getMessages().map((message) => [message.role, message.content])).toEqual([
          ['user', 'finish the task'],
          ['system', '[Cerebellum] The turn ended repeatedly without a valid completion signal or final answer.'],
        ]);
      } finally {
        await localOrch.stop();
      }
    });

    it('injects transient resume context after a stalled retry', async () => {
      vi.useFakeTimers();

      const localOrch = new Orchestrator({ streamStallThreshold: 10, maxNudgeRetries: 1 });
      try {
        localOrch.registerTool('workTool', createTestTool('Opened the profile page.'));
        localOrch.setCerebellum({
          ...createMockCerebellum(),
          verifyToolResult: vi.fn(async () => ({ passed: false, checks: [], modelVerdict: false })),
        });

        const attemptInputs: Message[][] = [];
        let attempts = 0;
        const cerebrum: CerebrumAdapter = {
          stream: vi.fn(async (messages, _tools, callbacks, options) => {
            attemptInputs.push(messages);
            attempts++;

            if (attempts === 1) {
              await callbacks.onToolCall({ id: 'tool-1', name: 'workTool', args: {} });
              callbacks.onChunk('Drafting the final report after opening the profile page.');

              await new Promise<never>((_resolve, reject) => {
                const signal = options?.abortSignal;
                if (!signal) {
                  reject(new Error('missing abort signal'));
                  return;
                }
                const onAbort = () => reject(new Error('intentional nudge abort'));
                if (signal.aborted) {
                  onAbort();
                  return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
              });
              return;
            }

            callbacks.onFinish('Recovered reply');
          }),
          summarize: vi.fn(async () => 'summary'),
        };
        localOrch.setCerebrum(cerebrum);
        localOrch.startConversation();

        const sendPromise = localOrch.sendMessage('finish the task');
        await vi.advanceTimersByTimeAsync(30_000);
        await sendPromise;

        expect(attempts).toBe(2);
        const retryMessages = attemptInputs[1] ?? [];
        const resumeMessage = retryMessages.find(
          (message) => message.role === 'system' && message.metadata?.source === 'watchdog-resume',
        );
        expect(resumeMessage?.content).toContain('Opened the profile page.');
        expect(resumeMessage?.content).toContain('Drafting the final report after opening the profile page.');
        expect(localOrch.getMessages().some((message) => message.metadata?.source === 'watchdog-resume')).toBe(false);
      } finally {
        vi.useRealTimers();
        await localOrch.stop();
      }
    });

    it('injects transient resume context after a completion retry', async () => {
      const localOrch = new Orchestrator({ maxNudgeRetries: 1 });
      try {
        localOrch.registerTool('workTool', createTestTool('Opened the profile page.'));

        const attemptInputs: Message[][] = [];
        let attempts = 0;
        const cerebrum: CerebrumAdapter = {
          stream: vi.fn(async (messages, _tools, callbacks) => {
            attemptInputs.push(messages);
            attempts++;

            if (attempts === 1) {
              await callbacks.onToolCall({ id: 'tool-1', name: 'workTool', args: {} });
              callbacks.onChunk('I followed the account and am ready to publish the summary.');
              callbacks.onFinish(
                '',
                [{ id: 'tool-1', name: 'workTool', args: {} }],
                makeFinishMeta({
                  finishReason: 'tool-calls',
                  rawFinishReason: 'tool_calls',
                  stepFinishReasons: ['tool-calls'],
                  toolCallCount: 1,
                  hadToolActivity: true,
                  textChars: 0,
                }),
              );
              return;
            }

            await callbacks.onToolCall({
              id: 'sig-1',
              name: 'task_complete',
              args: { summary: 'done', evidence: 'Observed the profile update.' },
            });
            callbacks.onFinish(
              'Completed after resuming the confirmed state.',
              [{ id: 'sig-1', name: 'task_complete', args: { summary: 'done', evidence: 'Observed the profile update.' } }],
              makeFinishMeta({
                finishReason: 'stop',
                rawFinishReason: 'stop',
                stepFinishReasons: ['tool-calls', 'stop'],
                toolCallCount: 1,
                hadToolActivity: true,
                textChars: 'Completed after resuming the confirmed state.'.length,
                stepCount: 2,
              }),
            );
          }),
          summarize: vi.fn(async () => 'summary'),
        };
        localOrch.setCerebrum(cerebrum);
        localOrch.startConversation();

        await localOrch.sendMessage('finish the task');

        expect(attempts).toBe(2);
        const retryMessages = attemptInputs[1] ?? [];
        const resumeMessage = retryMessages.find(
          (message) => message.role === 'system' && message.metadata?.source === 'completion-resume',
        );
        expect(resumeMessage?.content).toContain('Opened the profile page.');
        expect(resumeMessage?.content).toContain('I followed the account and am ready to publish the summary.');
        expect(localOrch.getMessages().some((message) => message.metadata?.source === 'completion-resume')).toBe(false);

        // The retry input must NOT contain the failed attempt's tool messages
        const retryToolMessages = retryMessages.filter((m) => m.role === 'tool');
        expect(retryToolMessages).toHaveLength(0);

        // After success, the conversation store should NOT contain the failed attempt's tool output
        const storedMessages = localOrch.getMessages();
        const storedToolMessages = storedMessages.filter((m) => m.role === 'tool' && m.content === 'Opened the profile page.');
        expect(storedToolMessages).toHaveLength(0);
      } finally {
        await localOrch.stop();
      }
    });

    it('preserves long browser progress and checkpoints across completion retries', async () => {
      const localOrch = new Orchestrator({ maxNudgeRetries: 1 });
      try {
        localOrch.registerTool('browserConnect', createStructuredTool('Connected to Chrome via extension', {
          action: 'connect_browser',
          summary: 'Connected to Chrome via extension.',
          stateChanging: true,
        }));
        localOrch.registerTool('browserNavigateProfile', createStructuredTool('Navigated to https://x.com/CereWorkerX - Title: Profile / X', {
          action: 'navigate',
          summary: 'Opened the CereWorkerX profile on X.',
          url: 'https://x.com/CereWorkerX',
          stateChanging: true,
        }));
        localOrch.registerTool('browserGetProfileText', createStructuredTool('Reviewed recent profile posts.', {
          action: 'read_page_text',
          summary: 'Reviewed recent profile posts for continuity.',
          url: 'https://x.com/CereWorkerX',
          stateChanging: false,
        }));
        localOrch.registerTool('browserNavigateHome', createStructuredTool('Navigated to https://x.com/home - Title: Home / X', {
          action: 'navigate',
          summary: 'Returned to the X home timeline.',
          url: 'https://x.com/home',
          stateChanging: true,
        }));
        localOrch.registerTool('browserLikePost', createStructuredTool('clicked like', {
          action: 'click_text',
          summary: 'Liked the Science girl post on the home timeline.',
          url: 'https://x.com/home',
          targetText: 'Like',
          stateChanging: true,
        }));

        const attemptInputs: Message[][] = [];
        let attempts = 0;
        const cerebrum: CerebrumAdapter = {
          stream: vi.fn(async (messages, _tools, callbacks) => {
            attemptInputs.push(messages);
            attempts++;

            if (attempts === 1) {
              await callbacks.onToolCall({ id: 'tool-1', name: 'browserConnect', args: {} });
              await callbacks.onToolCall({ id: 'tool-2', name: 'browserNavigateProfile', args: {} });
              await callbacks.onToolCall({
                id: 'cp-1',
                name: 'task_checkpoint',
                args: { step: 'session verified', status: 'done', evidence: 'Connected to Chrome and opened the CereWorkerX profile.' },
              });
              await callbacks.onToolCall({ id: 'tool-3', name: 'browserGetProfileText', args: {} });
              await callbacks.onToolCall({ id: 'tool-4', name: 'browserNavigateHome', args: {} });
              await callbacks.onToolCall({ id: 'tool-5', name: 'browserLikePost', args: {} });
              await callbacks.onToolCall({
                id: 'cp-2',
                name: 'task_checkpoint',
                args: { step: 'engagement pass', status: 'done', evidence: 'Liked one Science girl post on the home timeline.' },
              });
              callbacks.onFinish(
                '',
                [
                  { id: 'tool-1', name: 'browserConnect', args: {} },
                  { id: 'tool-2', name: 'browserNavigateProfile', args: {} },
                  { id: 'cp-1', name: 'task_checkpoint', args: { step: 'session verified', status: 'done', evidence: 'Connected to Chrome and opened the CereWorkerX profile.' } },
                  { id: 'tool-3', name: 'browserGetProfileText', args: {} },
                  { id: 'tool-4', name: 'browserNavigateHome', args: {} },
                  { id: 'tool-5', name: 'browserLikePost', args: {} },
                  { id: 'cp-2', name: 'task_checkpoint', args: { step: 'engagement pass', status: 'done', evidence: 'Liked one Science girl post on the home timeline.' } },
                ],
                makeFinishMeta({
                  finishReason: 'tool-calls',
                  rawFinishReason: 'tool_calls',
                  stepFinishReasons: ['tool-calls'],
                  toolCallCount: 7,
                  hadToolActivity: true,
                  textChars: 0,
                }),
              );
              return;
            }

            await callbacks.onToolCall({
              id: 'sig-1',
              name: 'task_complete',
              args: {
                summary: 'Finished the daily X run.',
                evidence: 'The session was verified, profile continuity was checked, and one like was already confirmed in the retry ledger.',
              },
            });
            callbacks.onFinish(
              'Completed from preserved progress.',
              [{ id: 'sig-1', name: 'task_complete', args: { summary: 'Finished the daily X run.', evidence: 'The session was verified, profile continuity was checked, and one like was already confirmed in the retry ledger.' } }],
              makeFinishMeta({
                finishReason: 'stop',
                rawFinishReason: 'stop',
                stepFinishReasons: ['stop'],
                toolCallCount: 1,
                hadToolActivity: true,
                textChars: 'Completed from preserved progress.'.length,
              }),
            );
          }),
          summarize: vi.fn(async () => 'summary'),
        };

        localOrch.setCerebrum(cerebrum);
        localOrch.startConversation();
        await localOrch.sendMessage("handle today's X task");

        expect(attempts).toBe(2);
        const retryMessages = attemptInputs[1] ?? [];
        const resumeMessage = retryMessages.find(
          (message) => message.role === 'system' && message.metadata?.source === 'completion-resume',
        );
        expect(resumeMessage?.content).toContain('session verified');
        expect(resumeMessage?.content).toContain('engagement pass');
        expect(resumeMessage?.content).toContain('Opened the CereWorkerX profile on X.');
        expect(resumeMessage?.content).toContain('Liked the Science girl post on the home timeline.');
        expect(resumeMessage?.content).toContain('Current URL: https://x.com/home');
        expect(retryMessages.filter((message) => message.role === 'tool')).toHaveLength(0);
        expect(localOrch.getMessages().map((message) => [message.role, message.content])).toEqual([
          ['user', "handle today's X task"],
          ['cerebrum', 'Completed from preserved progress.'],
        ]);
      } finally {
        await localOrch.stop();
      }
    });

    it('uses a longer waiting_model stall threshold with backoff across retries', async () => {
      vi.useFakeTimers();

      const localOrch = new Orchestrator({ streamStallThreshold: 10, maxNudgeRetries: 2 });
      try {
        localOrch.setCerebellum({
          ...createMockCerebellum(),
          verifyToolResult: vi.fn(async () => ({ passed: false, checks: [], modelVerdict: false })),
        });

        let attempts = 0;
        const nudgeTimes: number[] = [];
        const cerebrum: CerebrumAdapter = {
          stream: vi.fn(async (_messages, _tools, callbacks, options) => {
            attempts++;
            if (attempts < 3) {
              await new Promise<never>((_resolve, reject) => {
                const signal = options?.abortSignal;
                if (!signal) {
                  reject(new Error('missing abort signal'));
                  return;
                }
                const onAbort = () => reject(new Error('intentional nudge abort'));
                if (signal.aborted) {
                  onAbort();
                  return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
              });
              return;
            }

            callbacks.onFinish('Recovered after patient retries.');
          }),
          summarize: vi.fn(async () => 'summary'),
        };
        localOrch.setCerebrum(cerebrum);
        localOrch.startConversation();
        localOrch.on('cerebrum:stall:nudge', () => nudgeTimes.push(Date.now()));

        const sendPromise = localOrch.sendMessage('finish the task');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(nudgeTimes).toEqual([]);

        await vi.advanceTimersByTimeAsync(15_000);
        expect(nudgeTimes).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(nudgeTimes).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(15_000);
        expect(nudgeTimes).toHaveLength(2);

        await sendPromise;
        expect(attempts).toBe(3);
      } finally {
        vi.useRealTimers();
        await localOrch.stop();
      }
    });

    it('emits error event on stream failure', async () => {
      const cerebrum = createMockCerebrum();
      (cerebrum.stream as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stream fail'));
      orch.setCerebrum(cerebrum);
      orch.startConversation();

      const handler = vi.fn();
      orch.on('error', handler);
      await orch.sendMessage('hi');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', error: expect.any(Error) }),
      );
    });
  });

  // --- Emergency stop ---

  describe('emergencyStop', () => {
    it('emits emergency:stop event', () => {
      const handler = vi.fn();
      orch.on('emergency:stop', handler);
      orch.emergencyStop();
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not throw without sub-agent manager', () => {
      expect(() => orch.emergencyStop()).not.toThrow();
    });
  });

  // --- Fine-tuning ---

  describe('fine-tuning', () => {
    it('triggerFineTune throws without cerebellum fine-tune methods', async () => {
      orch.setCerebellum({ isConnected: () => true, verifyToolResult: vi.fn() });
      await expect(orch.triggerFineTune()).rejects.toThrow('fine-tuning not available');
    });

    it('triggerFineTune calls data provider and ingests data', async () => {
      const cerebellum = createMockCerebellum();
      orch.setCerebellum(cerebellum);

      const pairs = [{ instruction: 'q', response: 'a', source: 'test', createdAt: Date.now() }];
      orch.setFineTuneDataProvider(async () => pairs);

      await orch.triggerFineTune();

      expect(cerebellum.ingestTrainingData).toHaveBeenCalledWith(pairs);
      expect(cerebellum.startFineTune).toHaveBeenCalledWith({ method: 'auto' });
    });

    it('triggerFineTune emits finetune:start event', async () => {
      const cerebellum = createMockCerebellum();
      orch.setCerebellum(cerebellum);

      const pairs = [{ instruction: 'q', response: 'a', source: 'test', createdAt: Date.now() }];
      orch.setFineTuneDataProvider(async () => pairs);

      const handler = vi.fn();
      orch.on('finetune:start', handler);
      await orch.triggerFineTune();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'finetune:start', jobId: 'ft-1' }),
      );
    });

    it('triggerFineTune throws when startFineTune fails', async () => {
      const cerebellum = createMockCerebellum();
      (cerebellum.startFineTune as ReturnType<typeof vi.fn>).mockResolvedValue({
        jobId: '', started: false, error: 'GPU busy',
      });
      orch.setCerebellum(cerebellum);

      const pairs = [{ instruction: 'q', response: 'a', source: 'test', createdAt: Date.now() }];
      orch.setFineTuneDataProvider(async () => pairs);

      await expect(orch.triggerFineTune()).rejects.toThrow('GPU busy');
    });

    it('triggerFineTune defers when not enough training data', async () => {
      const cerebellum = createMockCerebellum();
      (cerebellum.ingestTrainingData as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      orch.setCerebellum(cerebellum);

      const pairs = [{ instruction: 'q', response: 'a', source: 'test', createdAt: Date.now() }];
      orch.setFineTuneDataProvider(async () => pairs);

      await expect(orch.triggerFineTune()).rejects.toThrow('Not enough training data');
      expect(cerebellum.ingestTrainingData).toHaveBeenCalled();
      expect(cerebellum.startFineTune).not.toHaveBeenCalled();
    });

    it('triggerFineTune skips ingestion when no data provider but defers', async () => {
      const cerebellum = createMockCerebellum();
      orch.setCerebellum(cerebellum);
      // No setFineTuneDataProvider call — totalPending = 0

      await expect(orch.triggerFineTune()).rejects.toThrow('Not enough training data');
      expect(cerebellum.ingestTrainingData).not.toHaveBeenCalled();
      expect(cerebellum.startFineTune).not.toHaveBeenCalled();
    });

    it('setFineTuneDataProvider accepts custom method', async () => {
      const cerebellum = createMockCerebellum();
      orch.setCerebellum(cerebellum);
      const pairs = [{ instruction: 'q', response: 'a', source: 'test', createdAt: Date.now() }];
      orch.setFineTuneDataProvider(async () => pairs, 'lora');
      await orch.triggerFineTune();

      expect(cerebellum.startFineTune).toHaveBeenCalledWith({ method: 'lora' });
    });
  });

  // --- start / stop ---

  describe('start and stop', () => {
    it('start creates conversation if none active', async () => {
      orch.setCerebrum(createMockCerebrum());
      await orch.start();
      expect(orch.getActiveConversationId()).toBeTruthy();
    });

    it('stop cleans up listeners', async () => {
      const handler = vi.fn();
      orch.on('emergency:stop', handler);
      await orch.stop();
      orch.emit({ type: 'emergency:stop' });
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
