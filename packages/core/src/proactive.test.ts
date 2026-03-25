import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProactiveController } from './proactive.js';
import type { PlanStore, Plan } from './plan-store.js';
import type { InstanceStore, InstanceIdentity } from './instance.js';

function mockPlanStore(plans: Plan[] = []): PlanStore {
  return {
    getInProgress: vi.fn().mockReturnValue(plans),
    get: vi.fn().mockImplementation((id: string) => plans.find((p) => p.id === id)),
    updateStatus: vi.fn(),
    updateStep: vi.fn(),
    save: vi.fn().mockImplementation((p) => ({ ...p, id: p.id ?? 'plan-1', createdAt: '', updatedAt: '' })),
    getByTask: vi.fn(),
    delete: vi.fn(),
  } as unknown as PlanStore;
}

function mockInstanceStore(identity?: Partial<InstanceIdentity>): InstanceStore {
  const full: InstanceIdentity = {
    id: 'inst-123',
    createdAt: '2026-01-01T00:00:00Z',
    lastBootAt: '2026-03-25T00:00:00Z',
    profile: { name: 'TestBot', role: 'tester', traits: [], source: 'static' },
    conversationCount: 10,
    finetuneLineage: [],
    activeCheckpoint: null,
    schemaVersion: 1,
    ...identity,
  };
  return {
    get: vi.fn().mockReturnValue(full),
    load: vi.fn().mockReturnValue(full),
    updateBoot: vi.fn(),
    recordFineTune: vi.fn(),
    incrementConversation: vi.fn(),
  } as unknown as InstanceStore;
}

describe('ProactiveController', () => {
  let sendToUser: ReturnType<typeof vi.fn>;
  let broadcastToChannels: ReturnType<typeof vi.fn>;
  let runTask: ReturnType<typeof vi.fn>;
  let isTaskRunning: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendToUser = vi.fn();
    broadcastToChannels = vi.fn().mockResolvedValue(undefined);
    runTask = vi.fn().mockResolvedValue({ success: true });
    isTaskRunning = vi.fn().mockReturnValue(false);
  });

  it('does nothing when disabled', async () => {
    const controller = new ProactiveController({
      planStore: mockPlanStore([{
        id: 'p1', taskId: 't1', goal: 'test', steps: [], createdAt: '', updatedAt: '', status: 'in_progress',
      }]),
      instanceStore: mockInstanceStore(),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: false, resumeOnBoot: 'auto', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    await controller.resumeUnfinished();
    expect(sendToUser).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
  });

  it('notifies about unfinished plans in notify mode', async () => {
    const plans: Plan[] = [{
      id: 'p1', taskId: 't1', goal: 'Deploy app', steps: [
        { description: 'Build', status: 'done' },
        { description: 'Push', status: 'pending' },
      ], createdAt: '', updatedAt: '', status: 'in_progress',
    }];

    const controller = new ProactiveController({
      planStore: mockPlanStore(plans),
      instanceStore: mockInstanceStore(),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: true, resumeOnBoot: 'notify', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    await controller.resumeUnfinished();

    expect(sendToUser).toHaveBeenCalledOnce();
    expect(sendToUser.mock.calls[0][0]).toContain('Deploy app');
    expect(sendToUser.mock.calls[0][0]).toContain('1/2 steps done');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('auto-resumes plans in auto mode', async () => {
    const plans: Plan[] = [{
      id: 'p1', taskId: 't1', goal: 'Deploy', steps: [], createdAt: '', updatedAt: '', status: 'in_progress',
    }];

    const controller = new ProactiveController({
      planStore: mockPlanStore(plans),
      instanceStore: mockInstanceStore(),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: true, resumeOnBoot: 'auto', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    await controller.resumeUnfinished();

    // Should send a "Resuming task" message
    expect(sendToUser).toHaveBeenCalled();
    expect(sendToUser.mock.calls[0][0]).toContain('Resuming task');
  });

  it('skips tasks already running', async () => {
    isTaskRunning.mockReturnValue(true);
    const plans: Plan[] = [{
      id: 'p1', taskId: 't1', goal: 'Running', steps: [], createdAt: '', updatedAt: '', status: 'in_progress',
    }];

    const controller = new ProactiveController({
      planStore: mockPlanStore(plans),
      instanceStore: mockInstanceStore(),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: true, resumeOnBoot: 'auto', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    await controller.resumeUnfinished();
    expect(runTask).not.toHaveBeenCalled();
  });

  it('sends status report', async () => {
    const controller = new ProactiveController({
      planStore: mockPlanStore(),
      instanceStore: mockInstanceStore({
        finetuneLineage: [{
          jobId: 'ft-1', method: 'lora', completedAt: '2026-03-20T00:00:00Z',
          checkpointPath: '/cp/1', loss: 0.42, trainingPairs: 50,
        }],
      }),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: true, resumeOnBoot: 'auto', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    await controller.sendStatusReport();

    expect(sendToUser).toHaveBeenCalledOnce();
    const report = sendToUser.mock.calls[0][0];
    expect(report).toContain('Status Report');
    expect(report).toContain('TestBot');
    expect(report).toContain('Fine-tune cycles: 1');
  });

  it('handles heartbeat invoke', async () => {
    const controller = new ProactiveController({
      planStore: mockPlanStore(),
      instanceStore: mockInstanceStore(),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: true, resumeOnBoot: 'auto', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    await controller.onHeartbeatInvoke('daily-check', 'Check server health');

    expect(runTask).toHaveBeenCalledWith('daily-check', 'Check server health', { autoMode: true });
    expect(sendToUser).toHaveBeenCalled();
    expect(sendToUser.mock.calls[0][0]).toContain('completed successfully');
  });

  it('respects maxConcurrentProactive', async () => {
    // Make runTask block forever
    runTask.mockImplementation(() => new Promise(() => {}));

    const plans: Plan[] = [
      { id: 'p1', taskId: 't1', goal: 'A', steps: [], createdAt: '', updatedAt: '', status: 'in_progress' },
      { id: 'p2', taskId: 't2', goal: 'B', steps: [], createdAt: '', updatedAt: '', status: 'in_progress' },
      { id: 'p3', taskId: 't3', goal: 'C', steps: [], createdAt: '', updatedAt: '', status: 'in_progress' },
    ];

    const controller = new ProactiveController({
      planStore: mockPlanStore(plans),
      instanceStore: mockInstanceStore(),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: true, resumeOnBoot: 'auto', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    await controller.resumeUnfinished();

    // Only 2 should start (maxConcurrentProactive = 2)
    const resumeMessages = sendToUser.mock.calls.filter(
      ([content]: [string]) => content.includes('Resuming task'),
    );
    expect(resumeMessages.length).toBe(2);
  });

  it('creates and manages plans', () => {
    const planStore = mockPlanStore();
    const controller = new ProactiveController({
      planStore,
      instanceStore: mockInstanceStore(),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: true, resumeOnBoot: 'auto', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    controller.createPlan('task-1', 'Build feature', ['Design', 'Implement', 'Test']);
    expect(planStore.save).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      goal: 'Build feature',
      steps: expect.arrayContaining([
        expect.objectContaining({ description: 'Design', status: 'pending' }),
      ]),
    }));

    controller.completeStep('plan-1', 0);
    expect(planStore.updateStep).toHaveBeenCalledWith('plan-1', 0, 'done');

    controller.completePlan('plan-1');
    expect(planStore.updateStatus).toHaveBeenCalledWith('plan-1', 'completed');

    controller.abandonPlan('plan-1');
    expect(planStore.updateStatus).toHaveBeenCalledWith('plan-1', 'abandoned');
  });

  it('stops cleanly', async () => {
    const plans: Plan[] = [{
      id: 'p1', taskId: 't1', goal: 'test', steps: [], createdAt: '', updatedAt: '', status: 'in_progress',
    }];

    const controller = new ProactiveController({
      planStore: mockPlanStore(plans),
      instanceStore: mockInstanceStore(),
      output: { sendToUser, broadcastToChannels },
      taskRunner: { runTask, isTaskRunning },
      config: { enabled: true, resumeOnBoot: 'auto', statusReports: true, statusReportSchedule: 'daily', maxConcurrentProactive: 2 },
    });

    controller.stop();
    await controller.resumeUnfinished();
    expect(sendToUser).not.toHaveBeenCalled();
  });
});
