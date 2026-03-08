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

export class CerebellumClient {
  private address: string;
  private connected = false;

  constructor(address = 'localhost:50051') {
    this.address = address;
  }

  async connect(): Promise<void> {
    // TODO: Implement gRPC connection in Phase 4
    this.connected = false;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getStatus(): Promise<CerebellumStatus | null> {
    if (!this.connected) return null;
    return null;
  }

  async registerTask(
    _description: string,
    _scheduleHint: string,
    _metadata?: Record<string, string>,
  ): Promise<string | null> {
    return null;
  }

  async unregisterTask(_taskId: string): Promise<void> {}

  async listTasks(): Promise<TaskState[]> {
    return [];
  }

  async *subscribeHeartbeat(_intervalSeconds = 30): AsyncIterable<HeartbeatEvent> {
    // TODO: Implement gRPC server-streaming in Phase 4
  }
}
