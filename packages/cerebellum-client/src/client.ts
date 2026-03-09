import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
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
  metadata?: Record<string, string>;
}

export interface TaskAction {
  taskId: string;
  action: 'invoke' | 'skip' | 'defer' | 'cancel';
  reason: string;
}

export interface HeartbeatEvent {
  timestamp: number;
  actions: TaskAction[];
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
    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const protoPath = resolve(currentDir, '../../../proto/cerebellum.proto');

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

      this.client = new CerebellumService(
        this.address,
        grpc.credentials.createInsecure(),
      );

      // Test connection with a deadline
      await new Promise<void>((resolve, reject) => {
        const deadline = new Date(Date.now() + 5000);
        this.client.waitForReady(deadline, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.connected = true;
    } catch {
      this.connected = false;
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
  ): Promise<string | null> {
    if (!this.connected) return null;

    return new Promise((resolve, reject) => {
      this.client.registerTask(
        { description, scheduleHint, metadata: metadata || {} },
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
            metadata: t.metadata,
          })),
        );
      });
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
      this.client.verifyToolResult(
        {
          toolName,
          toolArgs,
          toolOutput,
          claimedSuccess,
        },
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
}
