import { createLogger } from './logger.js';
import type { PlanStore, Plan } from './plan-store.js';
import type { InstanceStore } from './instance.js';

const log = createLogger('proactive');

export interface ProactiveConfig {
  enabled: boolean;
  resumeOnBoot: 'auto' | 'notify';
  statusReports: boolean;
  statusReportSchedule: 'hourly' | 'daily' | 'weekly';
  maxConcurrentProactive: number;
}

export interface ProactiveOutput {
  /** Send a message to the user via TUI (emits message:proactive event) */
  sendToUser(content: string, source: string): void;
  /** Broadcast to all connected IM channels */
  broadcastToChannels(content: string): Promise<void>;
}

export interface TaskRunner {
  runTask(taskId: string, goal: string, options?: { autoMode?: boolean }): Promise<{ success: boolean; error?: string }>;
  isTaskRunning(taskId: string): boolean;
}

export interface TextGenerator {
  generate(prompt: string): Promise<string>;
}

const DEFAULT_CONFIG: ProactiveConfig = {
  enabled: false,
  resumeOnBoot: 'auto',
  statusReports: true,
  statusReportSchedule: 'daily',
  maxConcurrentProactive: 2,
};

export class ProactiveController {
  private config: ProactiveConfig;
  private planStore: PlanStore;
  private instanceStore: InstanceStore;
  private output: ProactiveOutput;
  private taskRunner: TaskRunner;
  private textGenerator: TextGenerator | null;
  private activeProactive = 0;
  private stopped = false;

  constructor(options: {
    planStore: PlanStore;
    instanceStore: InstanceStore;
    output: ProactiveOutput;
    taskRunner: TaskRunner;
    textGenerator?: TextGenerator;
    config?: Partial<ProactiveConfig>;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.planStore = options.planStore;
    this.instanceStore = options.instanceStore;
    this.output = options.output;
    this.taskRunner = options.taskRunner;
    this.textGenerator = options.textGenerator ?? null;
  }

  /** Check for unfinished plans from previous session and resume them. */
  async resumeUnfinished(): Promise<void> {
    if (!this.config.enabled || this.stopped) return;

    const plans = this.planStore.getInProgress();
    if (plans.length === 0) {
      log.debug('No in-progress plans to resume');
      return;
    }

    log.info('Found in-progress plans to resume', { count: plans.length });

    if (this.config.resumeOnBoot === 'notify') {
      const summary = plans
        .map((p) => `- ${p.goal} (${this.completedSteps(p)}/${p.steps.length} steps done)`)
        .join('\n');
      this.output.sendToUser(
        `You have ${plans.length} unfinished task(s) from a previous session:\n${summary}\n\nSay "resume" or "resume <task>" to continue, or "abandon" to discard.`,
        'resume-check',
      );
      return;
    }

    // Auto resume mode
    for (const plan of plans) {
      if (this.stopped || this.activeProactive >= this.config.maxConcurrentProactive) break;
      if (!plan.taskId) continue;
      if (this.taskRunner.isTaskRunning(plan.taskId)) continue;

      this.output.sendToUser(
        `Resuming task: ${plan.goal} (${this.completedSteps(plan)}/${plan.steps.length} steps done)`,
        'resume',
      );

      this.activeProactive++;
      // Run in background — don't block startup
      this.runAndNotify(plan).finally(() => {
        this.activeProactive--;
      });
    }
  }

  /** Called when a heartbeat action triggers a task. */
  async onHeartbeatInvoke(taskId: string, goal: string): Promise<void> {
    if (!this.config.enabled || this.stopped) return;
    if (this.activeProactive >= this.config.maxConcurrentProactive) {
      log.debug('Max concurrent proactive tasks reached, skipping', { taskId });
      return;
    }
    if (this.taskRunner.isTaskRunning(taskId)) return;

    this.activeProactive++;
    try {
      const result = await this.taskRunner.runTask(taskId, goal, { autoMode: true });

      if (result.success) {
        this.notify(`Task "${taskId}" completed successfully.`, 'task-complete');
      } else {
        this.notify(`Task "${taskId}" failed: ${result.error}`, 'task-error');
      }
    } catch (err) {
      log.error('Proactive task execution failed', { taskId, error: String(err) });
      this.notify(`Task "${taskId}" crashed: ${err}`, 'task-error');
    } finally {
      this.activeProactive--;
    }
  }

  /** Generate and send a status report. */
  async sendStatusReport(): Promise<void> {
    if (!this.config.enabled || !this.config.statusReports || this.stopped) return;

    const instance = this.instanceStore.get();
    if (!instance) return;

    const inProgress = this.planStore.getInProgress();
    const ftCount = instance.finetuneLineage.length;
    const lastFt = instance.finetuneLineage[ftCount - 1];

    const lines = [
      `**Status Report** — ${new Date().toISOString().split('T')[0]}`,
      `Instance: ${instance.profile.name} (${instance.id.slice(0, 8)})`,
      `Conversations: ${instance.conversationCount}`,
      `Fine-tune cycles: ${ftCount}${lastFt ? ` (last: ${lastFt.completedAt.split('T')[0]}, loss: ${lastFt.loss.toFixed(3)})` : ''}`,
      `In-progress plans: ${inProgress.length}`,
    ];

    if (inProgress.length > 0) {
      lines.push('');
      for (const p of inProgress.slice(0, 5)) {
        lines.push(`- ${p.goal} (${this.completedSteps(p)}/${p.steps.length} steps)`);
      }
    }

    const report = lines.join('\n');

    // Use LLM to make it more natural if available
    let finalReport = report;
    if (this.textGenerator) {
      try {
        finalReport = await this.textGenerator.generate(
          `Rewrite this status report as a brief, natural message (2-3 sentences). Keep all numbers accurate:\n\n${report}`,
        );
      } catch {
        // Fall back to raw report
      }
    }

    this.notify(finalReport, 'status-report');
    log.info('Sent status report');
  }

  /** Create a plan for a task. */
  createPlan(taskId: string, goal: string, steps: string[], conversationId?: string): Plan {
    return this.planStore.save({
      taskId,
      goal,
      steps: steps.map((s) => ({ description: s, status: 'pending' as const })),
      conversationId,
      status: 'in_progress',
    });
  }

  /** Mark a plan step as done. */
  completeStep(planId: string, stepIndex: number): void {
    this.planStore.updateStep(planId, stepIndex, 'done');
  }

  /** Mark a plan as completed. */
  completePlan(planId: string): void {
    this.planStore.updateStatus(planId, 'completed');
  }

  /** Abandon a plan. */
  abandonPlan(planId: string): void {
    this.planStore.updateStatus(planId, 'abandoned');
  }

  stop(): void {
    this.stopped = true;
    log.info('ProactiveController stopped');
  }

  private async runAndNotify(plan: Plan): Promise<void> {
    if (!plan.taskId) return;

    try {
      const result = await this.taskRunner.runTask(plan.taskId, plan.goal, { autoMode: true });
      if (result.success) {
        this.planStore.updateStatus(plan.id, 'completed');
        this.notify(`Resumed task "${plan.goal}" completed successfully.`, 'resume-complete');
      } else {
        this.notify(`Resumed task "${plan.goal}" failed: ${result.error}`, 'resume-error');
      }
    } catch (err) {
      log.error('Resumed task failed', { planId: plan.id, error: String(err) });
      this.notify(`Resumed task "${plan.goal}" crashed: ${err}`, 'resume-error');
    }
  }

  private notify(content: string, source: string): void {
    this.output.sendToUser(content, source);
    this.output.broadcastToChannels(content).catch((err) => {
      log.warn('Failed to broadcast proactive message', { error: String(err) });
    });
  }

  private completedSteps(plan: Plan): number {
    return plan.steps.filter((s) => s.status === 'done').length;
  }
}
