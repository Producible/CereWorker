import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
    assessTurnRecovery: vi.fn(async () => ({
      action: 'retry' as const,
      operatorMessage: '[Cerebellum] Retry from the last verified state.',
      modelMessage:
        '[Cerebellum recovery guidance]\nRetry from the last verified state.\nEnd your final answer by calling task_complete or task_blocked.',
      diagnosis: 'Retry from the last verified state.',
      nextStep: 'Continue from the next unfinished step.',
      completedSteps: [],
    })),
    verifyToolResult: vi.fn(async () => ({ passed: false, checks: [], modelVerdict: false })),
    ingestTrainingData: vi.fn(async () => 0),
    startFineTune: vi.fn(async () => ({ jobId: '', started: false, error: '' })),
    getFineTuneStatus: vi.fn(async () => null),
  };
}

function createSupervisorClient(overrides: Record<string, unknown> = {}) {
  let connected = false;
  return {
    connect: vi.fn(async () => {
      connected = true;
    }),
    disconnect: vi.fn(async () => {
      connected = false;
    }),
    isConnected: vi.fn(() => connected),
    getStatus: vi.fn(async () => ({
      healthy: true,
      modelName: 'test-cerebellum',
      uptimeSeconds: 1,
      tasksRegistered: 0,
    })),
    registerTask: vi.fn(async () => null),
    unregisterTask: vi.fn(async () => {}),
    listTasks: vi.fn(async () => []),
    subscribeHeartbeat: vi.fn(async function* heartbeatStream() {
      return;
    }),
    syncManagedTasks: vi.fn(async (tasks: unknown[]) => tasks.length),
    reportSupervisorState: vi.fn(async () => []),
    assessTurnRecovery: vi.fn(async () => null),
    verifyToolResult: vi.fn(async () => null),
    ingestTrainingData: vi.fn(async () => 0),
    startFineTune: vi.fn(async () => ({ jobId: '', started: false, error: '' })),
    getFineTuneStatus: vi.fn(async () => null),
    ...overrides,
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

  it('hashes long configured task ids and rejects normalized collisions', async () => {
    const longA = `daily-x-status-${'a'.repeat(80)}`;
    const longB = `daily-x-status-${'b'.repeat(80)}`;
    const service = createService(
      makeConfig({
        tasks: [
          {
            id: longA,
            goal: 'Post the first long-id task.',
            schedule: 'every 3 hours',
            enabled: true,
            autoMode: true,
            timeoutMinutes: 10,
          },
          {
            id: longB,
            goal: 'Post the second long-id task.',
            schedule: 'daily at 10 pm',
            enabled: true,
            autoMode: true,
            timeoutMinutes: 10,
          },
        ],
      }),
      { homeDir: () => homeDir },
    );

    const ids = service.getTaskDefinitions().map((task) => task.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    await service.shutdown();

    expect(() =>
      createService(
        makeConfig({
          tasks: [
            {
              id: 'Alpha Task',
              goal: 'First task.',
              schedule: 'daily',
              enabled: true,
              autoMode: true,
              timeoutMinutes: 10,
            },
            {
              id: 'alpha-task',
              goal: 'Second task.',
              schedule: 'daily',
              enabled: true,
              autoMode: true,
              timeoutMinutes: 10,
            },
          ],
        }),
        { homeDir: () => homeDir },
      ),
    ).toThrow('Task id collision');
  });

  it('invokes a due scheduled task from the supervisor heartbeat without inbound chat', async () => {
    const supervisorClient = createSupervisorClient({
      reportSupervisorState: vi
        .fn()
        .mockResolvedValueOnce([
          {
            taskId: 'daily-x-update',
            action: 'invoke_task',
            reason: 'scheduled_time',
            scheduledFor: '2026-04-04T17:00:00Z',
            slotKey: '2026-04-04T17:00:00Z',
          },
        ])
        .mockResolvedValue([]),
      listTasks: vi.fn(async () => [
        {
          taskId: 'daily-x-update',
          description: 'Post the daily X update',
          status: 'pending',
          lastRun: 0,
          scheduleHint: 'daily at 10:00',
          metadata: { type: 'managed' },
        },
      ]),
    });

    const service = createService(
      makeConfig({
        cerebellum: {
          enabled: true,
          heartbeatInterval: 1,
          docker: { autoStart: false },
          verification: { enabled: false },
          finetune: { enabled: false },
        },
        tasks: [
          {
            id: 'daily-x-update',
            goal: 'Post the daily X update and report the result.',
            schedule: 'daily at 10:00',
            enabled: true,
            autoMode: true,
            timeoutMinutes: 10,
          },
        ],
      }),
      {
        homeDir: () => homeDir,
        createCerebellumClient: () => supervisorClient as never,
      },
    );

    service.cerebrum.stream = vi.fn(async (_messages, _tools, callbacks) => {
      const reply = 'Completed the scheduled X update.';
      callbacks.onChunk(reply);
      callbacks.onFinish(reply);
    });

    const started = await service.startCerebellum();
    expect(started).toEqual({ ok: true });

    for (let i = 0; i < 20; i += 1) {
      if (service.getTaskRuns('daily-x-update').length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const [task] = service.getTaskDefinitions();
    expect(task.schedulerStatus).toBe('registered');
    expect(task.activeConversationId).toBeTruthy();
    expect(task.lastResult).toBe('success');
    expect(service.getTaskRuns('daily-x-update')).toHaveLength(1);
    expect(supervisorClient.syncManagedTasks).toHaveBeenCalled();
    expect(supervisorClient.reportSupervisorState).toHaveBeenCalled();

    await service.shutdown();
  });

  it('leaves tasks pending on transient supervisor sync failure instead of marking them all failed', async () => {
    const supervisorClient = createSupervisorClient({
      syncManagedTasks: vi.fn(async () => {
        throw new Error('temporary sync outage');
      }),
    });

    const service = createService(
      makeConfig({
        cerebellum: {
          enabled: true,
          heartbeatInterval: 1,
          docker: { autoStart: false },
          verification: { enabled: false },
          finetune: { enabled: false },
        },
        tasks: [
          {
            id: 'task-one',
            goal: 'Post the first update.',
            schedule: 'every 3 hours',
            enabled: true,
            autoMode: true,
            timeoutMinutes: 10,
          },
          {
            id: 'task-two',
            goal: 'Post the second update.',
            schedule: 'daily at 10:00',
            enabled: true,
            autoMode: true,
            timeoutMinutes: 10,
          },
        ],
      }),
      {
        homeDir: () => homeDir,
        createCerebellumClient: () => supervisorClient as never,
      },
    );

    const started = await service.startCerebellum();
    expect(started).toEqual({ ok: true });

    const definitions = service.getTaskDefinitions();
    expect(definitions).toHaveLength(2);
    expect(definitions.every((task) => task.schedulerStatus === 'pending_cerebellum')).toBe(true);
    expect(definitions.some((task) => task.schedulerStatus === 'registration_failed')).toBe(false);

    await service.shutdown();
  });

  it('uses explicit execution surface metadata instead of goal-text browser inference', async () => {
    const syncManagedTasks = vi.fn(async (tasks: Array<{ metadata?: Record<string, string> }>) => tasks.length);
    const supervisorClient = createSupervisorClient({
      syncManagedTasks,
    });

    const service = createService(
      makeConfig({
        cerebellum: {
          enabled: true,
          heartbeatInterval: 1,
          docker: { autoStart: false },
          verification: { enabled: false },
          finetune: { enabled: false },
        },
        tasks: [
          {
            id: 'math-x-task',
            goal: 'Multiply x by 2 and write the result to the daily report.',
            schedule: 'every 3 hours',
            enabled: true,
            autoMode: true,
            timeoutMinutes: 10,
          },
          {
            id: 'x-api-task',
            goal: 'Post the X summary through the API and record the response.',
            schedule: 'every 3 hours',
            enabled: true,
            autoMode: true,
            timeoutMinutes: 10,
            executionSurface: 'api',
          },
          {
            id: 'x-browser-task',
            goal: 'Post the X summary through the browser UI.',
            schedule: 'every 3 hours',
            enabled: true,
            autoMode: true,
            timeoutMinutes: 10,
            executionSurface: 'browser',
          },
        ],
      }),
      {
        homeDir: () => homeDir,
        createCerebellumClient: () => supervisorClient as never,
      },
    );

    const started = await service.startCerebellum();
    expect(started).toEqual({ ok: true });
    const syncedTasks = syncManagedTasks.mock.calls.at(-1)?.[0] as Array<{ taskId: string; metadata?: Record<string, string> }>;
    expect(syncedTasks).toHaveLength(3);
    expect(syncedTasks.find((task) => task.taskId === 'math-x-task')?.metadata).toMatchObject({
      executionSurface: 'either',
      requiresBrowser: 'false',
    });
    expect(syncedTasks.find((task) => task.taskId === 'x-api-task')?.metadata).toMatchObject({
      executionSurface: 'api',
      requiresBrowser: 'false',
    });
    expect(syncedTasks.find((task) => task.taskId === 'x-browser-task')?.metadata).toMatchObject({
      executionSurface: 'browser',
      requiresBrowser: 'true',
    });

    await service.shutdown();
  });

  it('archives the exact training batch for each fine-tune round in human-readable files', async () => {
    const service = createService(
      makeConfig({
        cerebellum: {
          enabled: false,
          verification: { enabled: false },
          finetune: { enabled: true, method: 'auto', schedule: 'daily' },
        },
        hippocampus: { enabled: false },
      }),
    );

    service.orchestrator.setCerebellum(
      {
        isConnected: vi.fn(() => true),
        assessTurnRecovery: vi.fn(),
        verifyToolResult: vi.fn(),
        ingestTrainingData: vi.fn(async () => 6),
        startFineTune: vi.fn(async () => ({ jobId: 'ft-archive-1', started: true, error: '' })),
        getFineTuneStatus: vi.fn(async () => ({
          status: 'running' as const,
          jobId: 'ft-archive-1',
          progress: 0,
          currentStep: 0,
          totalSteps: 0,
          currentLoss: 0,
          error: '',
          checkpointPath: '',
          startedAt: Date.now(),
          completedAt: 0,
        })),
      },
      { enabled: false },
    );

    service.cerebrum.stream = vi.fn(async (_messages, _tools, callbacks) => {
      const reply =
        'The deployment pipeline runs tests, builds artifacts, and promotes the release after the verification checks pass successfully.';
      callbacks.onChunk(reply);
      callbacks.onFinish(reply);
    });

    await service.orchestrator.sendMessage(
      'Can you explain how the deployment pipeline works from start to finish?',
    );
    await service.orchestrator.triggerFineTune();

    const roundDir = join(homeDir, '.cereworker', 'finetune', 'rounds', 'ft-archive-1');
    expect(readFileSync(join(roundDir, 'training.jsonl'), 'utf-8')).toContain(
      'deployment pipeline works',
    );
    expect(readFileSync(join(roundDir, 'sources', 'conversations.jsonl'), 'utf-8')).toContain(
      'deployment pipeline works',
    );
    expect(
      readFileSync(
        join(homeDir, '.cereworker', 'finetune', 'queue', 'conversations.jsonl'),
        'utf-8',
      ),
    ).toBe('');

    await service.shutdown();
  });

  it('writes per-session Hippocampus memory for a completed conversation turn', async () => {
    const service = createService(
      makeConfig({
        hippocampus: { enabled: true },
      }),
      { homeDir: () => homeDir },
    );

    service.cerebrum.stream = vi.fn(async (_messages, _tools, callbacks) => {
      const reply = 'Checked the state and summarized the next step clearly.';
      callbacks.onChunk(reply);
      callbacks.onFinish(reply);
    });

    let endedSessionId = '';
    service.orchestrator.on('message:cerebrum:end', ({ sessionId }) => {
      endedSessionId = sessionId;
    });

    const conversationId = service.orchestrator.startConversation();
    await service.orchestrator.sendMessage('Please summarize the current state.', conversationId);

    const sessionPath = join(
      homeDir,
      '.cereworker',
      'memory',
      'session',
      `${conversationId}.md`,
    );
    expect(existsSync(sessionPath)).toBe(true);
    const sessionMemory = readFileSync(sessionPath, 'utf-8');
    expect(sessionMemory).toContain('**User**');
    expect(sessionMemory).toContain('Please summarize the current state.');
    expect(sessionMemory).toContain('**Assistant**');
    expect(sessionMemory).toContain('Checked the state and summarized the next step clearly.');

    expect(endedSessionId).toBeTruthy();
    const querySession = service.orchestrator.getQuerySession(conversationId, endedSessionId);
    expect(querySession?.memory?.summary).toBe(
      'Stored the latest user/assistant exchange in session memory.',
    );

    const trainingPath = join(
      homeDir,
      '.cereworker',
      'memory',
      'training',
      `${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    expect(existsSync(trainingPath)).toBe(true);
    const trainingContent = readFileSync(trainingPath, 'utf-8');
    expect(trainingContent).toContain('"kind":"session"');
    expect(trainingContent).toContain(`"conversationId":"${conversationId}"`);

    const dailyPath = join(
      homeDir,
      '.cereworker',
      'memory',
      'daily',
      `${new Date().toISOString().slice(0, 10)}.md`,
    );
    expect(existsSync(dailyPath)).toBe(false);

    await service.shutdown();
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
    service.orchestrator.on('message:system', ({ message }) =>
      systemMessages.push(message.content),
    );

    const sendPromise = service.orchestrator.sendMessage('hello from hung tool');
    await vi.advanceTimersByTimeAsync(15_000);
    await sendPromise;

    const messages = service.orchestrator.getMessages();
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
    expect(nudges).toEqual([1]);
    expect(systemMessages).toEqual(['[Cerebellum] Retry from the last verified state.']);
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

          signal.addEventListener(
            'abort',
            () => {
              // Intentionally never resolve or reject to simulate a provider teardown hang.
            },
            { once: true },
          );
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
      attemptInputs.push(
        messages.map(
          (message: { role: string; content: string; metadata?: Record<string, unknown> }) => ({
            role: message.role,
            content: message.content,
            source: message.metadata?.source,
          }),
        ),
      );
      attempts++;

      if (attempts === 1) {
        await callbacks.onToolCall({ id: 'tool-1', name: 'workTool', args: {} });
        callbacks.onChunk('I already reviewed the profile and just need to finalize the response.');
        callbacks.onFinish('', [{ id: 'tool-1', name: 'workTool', args: {} }], {
          finishReason: 'tool-calls',
          rawFinishReason: 'tool_calls',
          stepFinishReasons: ['tool-calls'],
          chunkCount: 1,
          textChars: 0,
          toolCallCount: 1,
          hadToolActivity: true,
          stepCount: 1,
          lastContentKind: 'tool-call',
          endedWithToolCall: true,
          hadFinalText: false,
        });
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
          {
            id: 'sig-1',
            name: 'task_complete',
            args: { summary: 'done', evidence: 'Observed verified work result.' },
          },
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
          lastContentKind: 'text',
          endedWithToolCall: false,
          hadFinalText: true,
        },
      );
    });

    const completionStages: string[] = [];
    service.orchestrator.on('cerebrum:completion', ({ stage }) => completionStages.push(stage));

    await service.orchestrator.sendMessage('finish the task');

    expect(attempts).toBe(2);
    const completionResumeMessage = attemptInputs[1]?.find((message) =>
      message.content.startsWith('[System fallback recovery]'),
    );
    expect(completionResumeMessage).toBeDefined();
    expect(completionResumeMessage?.content).toContain('verified work result');
    expect(completionResumeMessage?.content).toContain(
      'I already reviewed the profile and just need to finalize the response.',
    );
    expect(completionStages).toEqual([
      'guard_triggered',
      'retry_started',
      'signal_recorded',
      'retry_recovered',
    ]);
    // Failed attempt messages cleaned up; successful retry's tool results preserved
    expect(
      service.orchestrator.getMessages().map((message) => [message.role, message.content]),
    ).toEqual([
      ['user', 'finish the task'],
      ['tool', 'verified work result'],
      ['cerebrum', 'Completed with evidence.'],
    ]);
    expect(
      service.orchestrator
        .getMessages()
        .some((message) => message.metadata?.source === 'completion-resume'),
    ).toBe(false);

    await service.shutdown();
  });

  it('resumes a long browser-style task from preserved checkpoints instead of restarting cold', async () => {
    const service = createService(makeConfig());
    service.orchestrator.startConversation();
    service.orchestrator.registerTool('browserConnect', {
      description: 'connect browser',
      parameters: {},
      execute: async () => ({
        output: 'Connected to Chrome via extension',
        metadata: {
          resume: {
            action: 'connect_browser',
            summary: 'Connected to Chrome via extension.',
            stateChanging: true,
          },
        },
      }),
    });
    service.orchestrator.registerTool('browserNavigateProfile', {
      description: 'open profile',
      parameters: {},
      execute: async () => ({
        output: 'Navigated to https://x.com/CereWorkerX - Title: Profile / X',
        metadata: {
          resume: {
            action: 'navigate',
            summary: 'Opened the CereWorkerX profile on X.',
            url: 'https://x.com/CereWorkerX',
            stateChanging: true,
          },
        },
      }),
    });
    service.orchestrator.registerTool('browserReadTimeline', {
      description: 'read timeline',
      parameters: {},
      execute: async () => ({
        output: 'Reviewed recent profile posts.',
        metadata: {
          resume: {
            action: 'read_page_text',
            summary: 'Reviewed recent profile posts for continuity.',
            url: 'https://x.com/CereWorkerX',
            stateChanging: false,
          },
        },
      }),
    });
    service.orchestrator.registerTool('browserNavigateHome', {
      description: 'open home',
      parameters: {},
      execute: async () => ({
        output: 'Navigated to https://x.com/home - Title: Home / X',
        metadata: {
          resume: {
            action: 'navigate',
            summary: 'Returned to the X home timeline.',
            url: 'https://x.com/home',
            stateChanging: true,
          },
        },
      }),
    });
    service.orchestrator.registerTool('browserLikePost', {
      description: 'like a post',
      parameters: {},
      execute: async () => ({
        output: 'clicked like',
        metadata: {
          resume: {
            action: 'click_text',
            summary: 'Liked one Science girl post on the home timeline.',
            url: 'https://x.com/home',
            targetText: 'Like',
            stateChanging: true,
          },
        },
      }),
    });

    const attemptInputs: Array<Array<{ role: string; content: string; source?: unknown }>> = [];
    let attempts = 0;
    service.cerebrum.stream = vi.fn(async (messages, _tools, callbacks) => {
      attemptInputs.push(
        messages.map(
          (message: { role: string; content: string; metadata?: Record<string, unknown> }) => ({
            role: message.role,
            content: message.content,
            source: message.metadata?.source,
          }),
        ),
      );
      attempts++;

      if (attempts === 1) {
        await callbacks.onToolCall({ id: 'tool-1', name: 'browserConnect', args: {} });
        await callbacks.onToolCall({ id: 'tool-2', name: 'browserNavigateProfile', args: {} });
        await callbacks.onToolCall({
          id: 'cp-1',
          name: 'task_checkpoint',
          args: {
            step: 'session verified',
            status: 'done',
            evidence: 'Connected to Chrome and opened the CereWorkerX profile.',
          },
        });
        await callbacks.onToolCall({ id: 'tool-3', name: 'browserReadTimeline', args: {} });
        await callbacks.onToolCall({ id: 'tool-4', name: 'browserNavigateHome', args: {} });
        await callbacks.onToolCall({ id: 'tool-5', name: 'browserLikePost', args: {} });
        await callbacks.onToolCall({
          id: 'cp-2',
          name: 'task_checkpoint',
          args: {
            step: 'engagement pass',
            status: 'done',
            evidence: 'Liked one Science girl post on the home timeline.',
          },
        });
        callbacks.onFinish(
          '',
          [
            { id: 'tool-1', name: 'browserConnect', args: {} },
            { id: 'tool-2', name: 'browserNavigateProfile', args: {} },
            {
              id: 'cp-1',
              name: 'task_checkpoint',
              args: {
                step: 'session verified',
                status: 'done',
                evidence: 'Connected to Chrome and opened the CereWorkerX profile.',
              },
            },
            { id: 'tool-3', name: 'browserReadTimeline', args: {} },
            { id: 'tool-4', name: 'browserNavigateHome', args: {} },
            { id: 'tool-5', name: 'browserLikePost', args: {} },
            {
              id: 'cp-2',
              name: 'task_checkpoint',
              args: {
                step: 'engagement pass',
                status: 'done',
                evidence: 'Liked one Science girl post on the home timeline.',
              },
            },
          ],
          {
            finishReason: 'tool-calls',
            rawFinishReason: 'tool_calls',
            stepFinishReasons: ['tool-calls'],
            chunkCount: 1,
            textChars: 0,
            toolCallCount: 7,
            hadToolActivity: true,
            stepCount: 1,
            lastContentKind: 'tool-call',
            endedWithToolCall: true,
            hadFinalText: false,
          },
        );
        return;
      }

      await callbacks.onToolCall({
        id: 'sig-1',
        name: 'task_complete',
        args: {
          summary: 'Finished the daily X run.',
          evidence:
            'The retry ledger already shows the session verification, profile continuity check, and confirmed like.',
        },
      });
      callbacks.onFinish(
        'Completed from preserved browser progress.',
        [
          {
            id: 'sig-1',
            name: 'task_complete',
            args: {
              summary: 'Finished the daily X run.',
              evidence:
                'The retry ledger already shows the session verification, profile continuity check, and confirmed like.',
            },
          },
        ],
        {
          finishReason: 'stop',
          rawFinishReason: 'stop',
          stepFinishReasons: ['stop'],
          chunkCount: 1,
          textChars: 'Completed from preserved browser progress.'.length,
          toolCallCount: 1,
          hadToolActivity: true,
          stepCount: 1,
          lastContentKind: 'text',
          endedWithToolCall: false,
          hadFinalText: true,
        },
      );
    });

    await service.orchestrator.sendMessage('run the X task');

    expect(attempts).toBe(2);
    const resumeMessage = attemptInputs[1]?.find(
      (message) => message.source === 'completion-resume',
    );
    expect(resumeMessage?.content).toContain('session verified');
    expect(resumeMessage?.content).toContain('engagement pass');
    expect(resumeMessage?.content).toContain('Opened the CereWorkerX profile on X.');
    expect(resumeMessage?.content).toContain('Liked one Science girl post on the home timeline.');
    expect(resumeMessage?.content).toContain('Current URL: https://x.com/home');
    expect(attemptInputs[1]?.filter((message) => message.role === 'tool')).toHaveLength(0);
    expect(
      service.orchestrator.getMessages().map((message) => [message.role, message.content]),
    ).toEqual([
      ['user', 'run the X task'],
      ['cerebrum', 'Completed from preserved browser progress.'],
    ]);

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
        callbacks.onFinish('', [{ id: 'tool-1', name: 'workTool', args: {} }], {
          finishReason: 'tool-calls',
          rawFinishReason: 'tool_calls',
          stepFinishReasons: ['tool-calls'],
          chunkCount: 1,
          textChars: 0,
          toolCallCount: 1,
          hadToolActivity: true,
          stepCount: 1,
          lastContentKind: 'tool-call',
          endedWithToolCall: true,
          hadFinalText: false,
        });
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
          {
            id: 'sig-1',
            name: 'task_complete',
            args: { summary: 'done', evidence: 'Observed verified work result.' },
          },
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
          lastContentKind: 'text',
          endedWithToolCall: false,
          hadFinalText: true,
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
    expect(watchdogStages).toEqual(['stalled', 'nudge_requested', 'abort_issued', 'retry_started']);
    expect(completionStages).toEqual([
      'guard_triggered',
      'retry_started',
      'signal_recorded',
      'retry_recovered',
    ]);
    // Failed attempt messages cleaned up; successful retry's tool results preserved
    expect(
      service.orchestrator.getMessages().map((message) => [message.role, message.content]),
    ).toEqual([
      ['user', 'finish the task'],
      ['tool', 'verified work result'],
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

    const sessionsDirA = join(
      homeDir,
      '.cereworker',
      'conversations',
      savedMap[keyA],
      'sessions',
    );
    const sessionLedgersA = readdirSync(sessionsDirA)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) =>
        JSON.parse(
          `[${readFileSync(join(sessionsDirA, name), 'utf-8').trim().split('\n').join(',')}]`,
        ) as Array<{ type: string }>,
      );
    expect(
      sessionLedgersA.some((ledger) =>
        ledger.some((event) => event.type === 'channel_ingress')
        && ledger.some((event) => event.type === 'channel_egress'),
      ),
    ).toBe(true);

    await service.shutdown();
  });
});
