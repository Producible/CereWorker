import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

export interface CerebellumStatus {
  healthy: boolean;
  modelName: string;
  uptimeSeconds: number;
  tasksRegistered: number;
}

export interface TaskState {
  taskId: string;
  description: string;
  status: 'pending' | 'running' | 'waiting' | 'completed';
  lastRun?: number;
  scheduleHint: string;
  schedule?: TaskSchedule;
  metadata?: Record<string, string>;
}

export interface TaskAction {
  taskId: string;
  action:
    | 'invoke'
    | 'skip'
    | 'defer'
    | 'cancel'
    | 'invoke_task'
    | 'continue_task'
    | 'retry_task'
    | 'report_issue'
    | 'noop';
  reason: string;
  scheduledFor?: string;
  slotKey?: string;
}

export type SchedulerStatus =
  | 'registered'
  | 'pending_cerebellum'
  | 'registration_failed'
  | 'running'
  | 'disabled';

export type TaskSchedule =
  | { type: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' }
  | { type: 'daily_at'; time: string; timezone?: string; catchUpPolicy?: 'none' | 'once' }
  | { type: 'one_shot'; dueAt: string; timezone?: string; catchUpPolicy?: 'none' | 'once' };

export interface HeartbeatEvent {
  timestamp: number;
  actions: TaskAction[];
}

export interface SupervisorTaskState {
  taskId: string;
  description: string;
  enabled: boolean;
  kind: 'recurring' | 'one_shot';
  executionSurface?: 'browser' | 'api' | 'either' | 'none';
  scheduleHint: string;
  schedule: TaskSchedule;
  status: 'pending' | 'idle' | 'running' | 'success' | 'failure' | 'cancelled';
  createdAt?: string;
  lastRunAt?: string;
  lastScheduledSlot?: string;
  schedulerStatus?: SchedulerStatus;
  lastSummary?: string;
  metadata?: Record<string, string>;
}

export interface SupervisorState {
  timestamp: number;
  timezone: string;
  tasks: SupervisorTaskState[];
  activeTaskIds: string[];
  browserAvailable: boolean;
  channelsAvailable: boolean;
  cerebrumBusy: boolean;
  fineTuneRunning: boolean;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  description: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  modelVerdict: boolean;
}

export interface RecoveryBrowserTab {
  id: string;
  title?: string;
  url: string;
  active: boolean;
}

export interface RecoveryBrowserState {
  currentUrl?: string;
  activeTabId?: string;
  tabs?: RecoveryBrowserTab[];
}

export interface RecoveryProgressEntry {
  source: 'tool' | 'checkpoint';
  action: string;
  summary: string;
  toolName?: string;
  url?: string;
  tabId?: string;
  stateChanging: boolean;
  isError: boolean;
  checkpointStatus?: 'done' | 'in_progress';
}

export interface RecoveryTaskCheckpoint {
  step: string;
  status: 'done' | 'in_progress';
  evidence: string;
  summary: string;
}

export interface RecoveryBoundary {
  id: string;
  kind: 'tool' | 'checkpoint' | 'completion' | 'stall' | 'recovery';
  action: string;
  summary: string;
  createdAt: number;
  stateChanging: boolean;
  browserState?: RecoveryBrowserState;
  url?: string;
  tabId?: string;
  evidence?: string;
  checkpointStatus?: 'done' | 'in_progress';
}

export type TurnOutcome =
  | 'completed'
  | 'completed_no_text'
  | 'ended_on_tool_calls'
  | 'completion_signal_missing'
  | 'aborted'
  | 'stalled'
  | 'protocol_error';

export type StreamContentKind = 'text' | 'tool-call' | 'empty' | 'other' | 'error';

export interface TurnRecoveryRequest {
  conversationId: string;
  turnId: string;
  attempt: number;
  cause: 'stall' | 'completion';
  phase: string;
  activeToolName?: string;
  activeToolCallId?: string;
  stallRetryCount: number;
  completionRetryCount: number;
  finishReason?: string;
  turnOutcome: TurnOutcome;
  lastContentKind: StreamContentKind;
  elapsedSeconds?: number;
  partialContent?: string;
  latestUserMessage?: string;
  browserState: RecoveryBrowserState;
  progressEntries: RecoveryProgressEntry[];
  taskCheckpoints: RecoveryTaskCheckpoint[];
  latestBoundary?: RecoveryBoundary;
  recentBoundaries: RecoveryBoundary[];
  repetitionSignals: string[];
}

export interface TurnRecoveryAssessment {
  action: 'wait' | 'retry' | 'stop';
  operatorMessage: string;
  modelMessage: string;
  diagnosis: string;
  nextStep: string;
  completedSteps: string[];
  waitSeconds?: number;
}

export interface AgentHealthAction {
  agentId: string;
  action: 'ok' | 'ping' | 'retry' | 'cancel' | 'timeout';
  reason: string;
}

export interface AgentStateInput {
  id: string;
  task: string;
  status: string;
  spawnedAt: number;
  lastActivityAt: number;
  timeoutMs: number;
  messagesCount: number;
  toolCallsCount: number;
  retryCount: number;
  progressNote?: string;
  progressPercent?: number;
  lastProgressAt?: number;
  deadlineAt?: number;
}

export interface SystemStatus {
  healthy: boolean;
  modelName: string;
  uptimeSeconds: number;
  tasksRegistered: number;
  agentsTotal: number;
  agentsRunning: number;
  agentsCompleted: number;
  agentsFailed: number;
  pendingActions: AgentHealthAction[];
}

export interface FineTuneStatus {
  status: 'idle' | 'running' | 'completed' | 'failed';
  jobId: string;
  progress: number;
  currentStep: number;
  totalSteps: number;
  currentLoss: number;
  error: string;
  checkpointPath: string;
  startedAt: number;
  completedAt: number;
}

export interface FineTuneStartResult {
  jobId: string;
  started: boolean;
  error: string;
}

export interface TrainingPairInput {
  instruction: string;
  response: string;
  source: string;
  createdAt: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export class CerebellumClient {
  private address: string;
  private connected = false;
  private client: GrpcClient = null;

  constructor(address = 'localhost:50051') {
    this.address = address;
  }

  async connect(): Promise<void> {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    // Look for proto bundled with this package first, fall back to monorepo root
    let protoPath = resolve(currentDir, '../proto/cerebellum.proto');
    if (!existsSync(protoPath)) {
      protoPath = resolve(currentDir, '../../../proto/cerebellum.proto');
    }
    if (!existsSync(protoPath)) {
      this.connected = false;
      throw new Error(
        `Proto file not found at ${protoPath}. Reinstall @cereworker/cerebellum-client.`,
      );
    }

    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const CerebellumService = proto.cereworker.cerebellum.Cerebellum;

    this.client = new CerebellumService(this.address, grpc.credentials.createInsecure());

    // Test connection with a deadline
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = new Date(Date.now() + 5000);
        this.client.waitForReady(deadline, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.connected = true;
    } catch (err) {
      this.connected = false;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getStatus(): Promise<CerebellumStatus | null> {
    if (!this.connected) return null;

    return new Promise((resolve, reject) => {
      this.client.getStatus({}, (err: Error | null, response: GrpcClient) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          healthy: response.healthy,
          modelName: response.modelName,
          uptimeSeconds: response.uptimeSeconds,
          tasksRegistered: response.tasksRegistered,
        });
      });
    });
  }

  async registerTask(
    description: string,
    scheduleHint: string,
    metadata?: Record<string, string>,
    schedule?: TaskSchedule,
  ): Promise<string | null> {
    if (!this.connected) return null;

    return new Promise((resolve, reject) => {
      this.client.registerTask(
        {
          description,
          scheduleHint,
          metadata: metadata || {},
          schedule: this.serializeTaskSchedule(schedule),
        },
        (err: Error | null, response: GrpcClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(response.taskId);
        },
      );
    });
  }

  async unregisterTask(taskId: string): Promise<void> {
    if (!this.connected) return;

    return new Promise((resolve, reject) => {
      this.client.unregisterTask({ taskId }, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async listTasks(): Promise<TaskState[]> {
    if (!this.connected) return [];

    return new Promise((resolve, reject) => {
      this.client.listTasks({}, (err: Error | null, response: GrpcClient) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          (response.tasks || []).map((t: GrpcClient) => ({
            taskId: t.taskId,
            description: t.description,
            status: t.status,
            lastRun: t.lastRun,
            scheduleHint: t.scheduleHint,
            schedule: this.deserializeTaskSchedule(t.schedule),
            metadata: t.metadata,
          })),
        );
      });
    });
  }

  async syncManagedTasks(tasks: SupervisorTaskState[], timezone: string): Promise<number> {
    if (!this.connected) return 0;

    return new Promise((resolve, reject) => {
      this.client.syncManagedTasks(
        {
          timezone,
          tasks: tasks.map((task) => ({
            taskId: task.taskId,
            description: task.description,
            enabled: task.enabled,
            kind: task.kind,
            scheduleHint: task.scheduleHint,
            schedule: this.serializeTaskSchedule(task.schedule),
            status: task.status,
            createdAt: task.createdAt ?? '',
            lastRunAt: task.lastRunAt ?? '',
            lastScheduledSlot: task.lastScheduledSlot ?? '',
            schedulerStatus: task.schedulerStatus ?? '',
            lastSummary: task.lastSummary ?? '',
            metadata: task.metadata ?? {},
          })),
        },
        (err: Error | null, response: GrpcClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(response.syncedCount ?? 0);
        },
      );
    });
  }

  async reportSupervisorState(request: SupervisorState): Promise<TaskAction[]> {
    if (!this.connected) return [];

    return new Promise((resolve, reject) => {
      this.client.reportSupervisorState(
        {
          timestamp: request.timestamp,
          timezone: request.timezone,
          activeTaskIds: request.activeTaskIds,
          browserAvailable: request.browserAvailable,
          channelsAvailable: request.channelsAvailable,
          cerebrumBusy: request.cerebrumBusy,
          fineTuneRunning: request.fineTuneRunning,
          tasks: request.tasks.map((task) => ({
            taskId: task.taskId,
            description: task.description,
            enabled: task.enabled,
            kind: task.kind,
            scheduleHint: task.scheduleHint,
            schedule: this.serializeTaskSchedule(task.schedule),
            status: task.status,
            createdAt: task.createdAt ?? '',
            lastRunAt: task.lastRunAt ?? '',
            lastScheduledSlot: task.lastScheduledSlot ?? '',
            schedulerStatus: task.schedulerStatus ?? '',
            lastSummary: task.lastSummary ?? '',
            metadata: task.metadata ?? {},
          })),
        },
        (err: Error | null, response: GrpcClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(
            (response.actions || []).map((action: GrpcClient) => ({
              taskId: action.taskId,
              action: action.action,
              reason: action.reason,
              scheduledFor: action.scheduledFor || undefined,
              slotKey: action.slotKey || undefined,
            })),
          );
        },
      );
    });
  }

  async *subscribeHeartbeat(intervalSeconds = 30): AsyncIterable<HeartbeatEvent> {
    if (!this.connected) return;

    const stream = this.client.subscribeHeartbeat({ intervalSeconds });

    try {
      for await (const event of stream) {
        yield {
          timestamp: event.timestamp,
          actions: (event.actions || []).map((a: GrpcClient) => ({
            taskId: a.taskId,
            action: a.action,
            reason: a.reason,
            scheduledFor: a.scheduledFor || undefined,
            slotKey: a.slotKey || undefined,
          })),
        };
      }
    } catch (err) {
      // Stream ended or connection lost
      if ((err as grpc.ServiceError)?.code !== grpc.status.CANCELLED) {
        throw err;
      }
    }
  }

  async verifyToolResult(
    toolName: string,
    toolArgs: Record<string, string>,
    toolOutput: string,
    claimedSuccess: boolean,
  ): Promise<VerificationResult | null> {
    if (!this.connected) return null;

    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + 5_000);
      this.client.verifyToolResult(
        {
          toolName,
          toolArgs,
          toolOutput,
          claimedSuccess,
        },
        { deadline },
        (err: Error | null, response: GrpcClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({
            passed: response.passed,
            modelVerdict: response.modelVerdict,
            checks: (response.checks || []).map((c: GrpcClient) => ({
              name: c.name,
              passed: c.passed,
              description: c.description,
            })),
          });
        },
      );
    });
  }

  async assessTurnRecovery(request: TurnRecoveryRequest): Promise<TurnRecoveryAssessment | null> {
    if (!this.connected) return null;

    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + 5_000);
      this.client.assessTurnRecovery(
        {
          conversationId: request.conversationId,
          turnId: request.turnId,
          attempt: request.attempt,
          cause: request.cause,
          phase: request.phase,
          activeToolName: request.activeToolName ?? '',
          activeToolCallId: request.activeToolCallId ?? '',
          stallRetryCount: request.stallRetryCount,
          completionRetryCount: request.completionRetryCount,
          finishReason: request.finishReason ?? '',
          turnOutcome: request.turnOutcome,
          lastContentKind: request.lastContentKind,
          elapsedSeconds: request.elapsedSeconds ?? 0,
          partialContent: request.partialContent ?? '',
          latestUserMessage: request.latestUserMessage ?? '',
          browserState: {
            currentUrl: request.browserState.currentUrl ?? '',
            activeTabId: request.browserState.activeTabId ?? '',
            tabs: (request.browserState.tabs ?? []).map((tab: RecoveryBrowserTab) => ({
              id: tab.id,
              title: tab.title ?? '',
              url: tab.url,
              active: tab.active,
            })),
          },
          progressEntries: request.progressEntries.map((entry: RecoveryProgressEntry) => ({
            source: entry.source,
            action: entry.action,
            summary: entry.summary,
            toolName: entry.toolName ?? '',
            url: entry.url ?? '',
            tabId: entry.tabId ?? '',
            stateChanging: entry.stateChanging,
            isError: entry.isError,
            checkpointStatus: entry.checkpointStatus ?? '',
          })),
          taskCheckpoints: request.taskCheckpoints.map((checkpoint: RecoveryTaskCheckpoint) => ({
            step: checkpoint.step,
            status: checkpoint.status,
            evidence: checkpoint.evidence,
            summary: checkpoint.summary,
          })),
          latestBoundary: request.latestBoundary
            ? {
                id: request.latestBoundary.id,
                kind: request.latestBoundary.kind,
                action: request.latestBoundary.action,
                summary: request.latestBoundary.summary,
                createdAt: request.latestBoundary.createdAt,
                stateChanging: request.latestBoundary.stateChanging,
                browserState: request.latestBoundary.browserState
                  ? {
                      currentUrl: request.latestBoundary.browserState.currentUrl ?? '',
                      activeTabId: request.latestBoundary.browserState.activeTabId ?? '',
                      tabs: (request.latestBoundary.browserState.tabs ?? []).map(
                        (tab: RecoveryBrowserTab) => ({
                          id: tab.id,
                          title: tab.title ?? '',
                          url: tab.url,
                          active: tab.active,
                        }),
                      ),
                    }
                  : undefined,
                url: request.latestBoundary.url ?? '',
                tabId: request.latestBoundary.tabId ?? '',
                evidence: request.latestBoundary.evidence ?? '',
                checkpointStatus: request.latestBoundary.checkpointStatus ?? '',
              }
            : undefined,
          recentBoundaries: request.recentBoundaries.map((boundary: RecoveryBoundary) => ({
            id: boundary.id,
            kind: boundary.kind,
            action: boundary.action,
            summary: boundary.summary,
            createdAt: boundary.createdAt,
            stateChanging: boundary.stateChanging,
            browserState: boundary.browserState
              ? {
                  currentUrl: boundary.browserState.currentUrl ?? '',
                  activeTabId: boundary.browserState.activeTabId ?? '',
                  tabs: (boundary.browserState.tabs ?? []).map((tab: RecoveryBrowserTab) => ({
                    id: tab.id,
                    title: tab.title ?? '',
                    url: tab.url,
                    active: tab.active,
                  })),
                }
              : undefined,
            url: boundary.url ?? '',
            tabId: boundary.tabId ?? '',
            evidence: boundary.evidence ?? '',
            checkpointStatus: boundary.checkpointStatus ?? '',
          })),
          repetitionSignals: request.repetitionSignals,
        },
        { deadline },
        (err: Error | null, response: GrpcClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({
            action: response.action,
            operatorMessage: response.operatorMessage,
            modelMessage: response.modelMessage,
            diagnosis: response.diagnosis,
            nextStep: response.nextStep,
            completedSteps: response.completedSteps ?? [],
            waitSeconds: response.waitSeconds || undefined,
          });
        },
      );
    });
  }

  async reportAgentStates(agents: AgentStateInput[]): Promise<AgentHealthAction[]> {
    if (!this.connected) return [];

    const grpcAgents = agents.map((a) => ({
      id: a.id,
      task: a.task,
      status: a.status,
      spawnedAt: a.spawnedAt,
      lastActivityAt: a.lastActivityAt,
      timeoutMs: a.timeoutMs,
      messagesCount: a.messagesCount,
      toolCallsCount: a.toolCallsCount,
      retryCount: a.retryCount,
      progressNote: a.progressNote ?? '',
      progressPercent: a.progressPercent ?? -1,
      lastProgressAt: a.lastProgressAt ?? 0,
      deadlineAt: a.deadlineAt ?? 0,
    }));

    return new Promise((resolve, reject) => {
      this.client.reportAgentStates(
        { agents: grpcAgents },
        (err: Error | null, response: GrpcClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(
            (response.actions || []).map((a: GrpcClient) => ({
              agentId: a.agentId,
              action: a.action,
              reason: a.reason,
            })),
          );
        },
      );
    });
  }

  async getSystemStatus(): Promise<SystemStatus | null> {
    if (!this.connected) return null;

    return new Promise((resolve, reject) => {
      this.client.getSystemStatus({}, (err: Error | null, response: GrpcClient) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          healthy: response.healthy,
          modelName: response.modelName,
          uptimeSeconds: response.uptimeSeconds,
          tasksRegistered: response.tasksRegistered,
          agentsTotal: response.agentsTotal,
          agentsRunning: response.agentsRunning,
          agentsCompleted: response.agentsCompleted,
          agentsFailed: response.agentsFailed,
          pendingActions: (response.pendingActions || []).map((a: GrpcClient) => ({
            agentId: a.agentId,
            action: a.action,
            reason: a.reason,
          })),
        });
      });
    });
  }

  async ingestTrainingData(pairs: TrainingPairInput[]): Promise<number> {
    if (!this.connected) return 0;

    const grpcPairs = pairs.map((p) => ({
      instruction: p.instruction,
      response: p.response,
      source: p.source,
      createdAt: p.createdAt,
    }));

    return new Promise((resolve, reject) => {
      this.client.ingestTrainingData(
        { pairs: grpcPairs },
        (err: Error | null, response: GrpcClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(response.totalPending);
        },
      );
    });
  }

  async startFineTune(config?: {
    method?: string;
    epochs?: number;
    learningRate?: number;
    batchSize?: number;
  }): Promise<FineTuneStartResult> {
    if (!this.connected) return { jobId: '', started: false, error: 'Not connected' };

    return new Promise((resolve, reject) => {
      this.client.startFineTune(
        {
          method: config?.method ?? 'auto',
          epochs: config?.epochs ?? 3,
          learningRate: config?.learningRate ?? 2e-4,
          batchSize: config?.batchSize ?? 4,
        },
        (err: Error | null, response: GrpcClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({
            jobId: response.jobId,
            started: response.started,
            error: response.error,
          });
        },
      );
    });
  }

  async getFineTuneStatus(): Promise<FineTuneStatus | null> {
    if (!this.connected) return null;

    return new Promise((resolve, reject) => {
      this.client.getFineTuneStatus({}, (err: Error | null, response: GrpcClient) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          status: response.status,
          jobId: response.jobId,
          progress: response.progress,
          currentStep: response.currentStep,
          totalSteps: response.totalSteps,
          currentLoss: response.currentLoss,
          error: response.error,
          checkpointPath: response.checkpointPath,
          startedAt: response.startedAt,
          completedAt: response.completedAt,
        });
      });
    });
  }

  private serializeTaskSchedule(schedule?: TaskSchedule): Record<string, unknown> | undefined {
    if (!schedule) return undefined;
    if (schedule.type === 'interval') {
      return {
        interval: {
          every: schedule.every,
          unit: schedule.unit,
        },
      };
    }
    if (schedule.type === 'daily_at') {
      return {
        dailyAt: {
          time: schedule.time,
          timezone: schedule.timezone ?? '',
          catchUpPolicy: schedule.catchUpPolicy ?? 'once',
        },
      };
    }
    return {
      oneShot: {
        dueAt: schedule.dueAt,
        timezone: schedule.timezone ?? '',
        catchUpPolicy: schedule.catchUpPolicy ?? 'once',
      },
    };
  }

  private deserializeTaskSchedule(raw: GrpcClient): TaskSchedule | undefined {
    if (!raw) return undefined;
    if (raw.interval && Number(raw.interval.every) > 0) {
      return {
        type: 'interval',
        every: Number(raw.interval.every),
        unit: raw.interval.unit,
      };
    }
    if (raw.dailyAt && raw.dailyAt.time) {
      return {
        type: 'daily_at',
        time: raw.dailyAt.time,
        timezone: raw.dailyAt.timezone || undefined,
        catchUpPolicy: raw.dailyAt.catchUpPolicy || undefined,
      };
    }
    if (raw.oneShot && raw.oneShot.dueAt) {
      return {
        type: 'one_shot',
        dueAt: raw.oneShot.dueAt,
        timezone: raw.oneShot.timezone || undefined,
        catchUpPolicy: raw.oneShot.catchUpPolicy || undefined,
      };
    }
    return undefined;
  }
}
