import type { Message, ToolCall, ToolResult, TaskAction, CerebellumStatus, VerificationResult, AgentHealthAction, StreamPhase } from './types.js';

interface StreamDiagnosticEvent {
  elapsedSeconds?: number;
  phase: StreamPhase;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolStartedAt?: number;
}

export type WatchdogStage =
  | 'stalled'
  | 'nudge_requested'
  | 'abort_issued'
  | 'retry_started'
  | 'retry_recovered'
  | 'retry_failed'
  | 'teardown_timeout';

export type CompletionStage =
  | 'signal_recorded'
  | 'guard_triggered'
  | 'retry_started'
  | 'retry_recovered'
  | 'retry_failed';

export type OrchestratorEvent =
  | { type: 'message:user'; message: Message }
  | { type: 'message:system'; message: Message }
  | { type: 'message:cerebrum:start'; conversationId: string }
  | { type: 'message:cerebrum:chunk'; chunk: string }
  | { type: 'message:cerebrum:end'; message: Message }
  | { type: 'message:cerebrum:toolcall'; toolCall: ToolCall }
  | { type: 'tool:start'; callId: string; name: string }
  | { type: 'tool:end'; result: ToolResult }
  | { type: 'verification:start'; callId: string; toolName: string }
  | { type: 'verification:end'; result: VerificationResult }
  | { type: 'heartbeat:tick'; actions: TaskAction[] }
  | { type: 'cerebellum:loading'; phase: string; attempt?: number; maxAttempts?: number }
  | { type: 'cerebellum:status'; status: CerebellumStatus }
  | { type: 'agent:spawned'; agentId: string; task: string }
  | { type: 'agent:completed'; agentId: string; result: string }
  | { type: 'agent:failed'; agentId: string; error: string }
  | { type: 'agent:health'; actions: AgentHealthAction[] }
  | { type: 'agent:progress'; agentId: string; note: string; percent?: number }
  | { type: 'agent:recovered'; agentId: string; task: string }
  | { type: 'exec:approval-required'; command: string }
  | { type: 'exec:blocked'; command: string; reason: string }
  | { type: 'emergency:stop' }
  | { type: 'node:connected'; nodeId: string; capabilities: string[] }
  | { type: 'node:disconnected'; nodeId: string; reason: string }
  | { type: 'node:invoke'; nodeId: string; tool: string; id: string }
  | { type: 'node:invoke-result'; nodeId: string; id: string; isError: boolean }
  | { type: 'finetune:start'; jobId: string }
  | { type: 'finetune:progress'; jobId: string; progress: number; loss: number }
  | { type: 'finetune:complete'; jobId: string; checkpointPath: string }
  | { type: 'finetune:error'; jobId: string; error: string }
  | { type: 'task:start'; taskId: string; goal: string }
  | { type: 'task:complete'; taskId: string }
  | { type: 'task:error'; taskId: string; error: string }
  | { type: 'browser:extension-connected' }
  | { type: 'browser:extension-disconnected' }
  | { type: 'conversation:resumed'; conversationId: string; messages: Message[] }
  | { type: 'message:proactive'; content: string; source: string }
  | { type: 'proactive:resume'; taskId: string; goal: string }
  | { type: 'proactive:report'; report: string }
  | ({ type: 'cerebrum:stall' } & StreamDiagnosticEvent)
  | ({ type: 'cerebrum:stall:nudge'; attempt: number } & StreamDiagnosticEvent)
  | ({
      type: 'cerebrum:watchdog';
      stage: WatchdogStage;
      turnId: string;
      attempt: number;
      conversationId: string;
      message: string;
    } & StreamDiagnosticEvent)
  | ({
      type: 'cerebrum:completion';
      stage: CompletionStage;
      turnId: string;
      attempt: number;
      conversationId: string;
      message: string;
      signal?: 'complete' | 'blocked' | 'none';
    } & StreamDiagnosticEvent)
  | { type: 'error'; error: Error };

type EventHandler<T> = (event: T) => void;

type EventMap = {
  [K in OrchestratorEvent['type']]: Extract<OrchestratorEvent, { type: K }>;
};

export class TypedEventEmitter {
  private handlers = new Map<string, Set<EventHandler<OrchestratorEvent>>>();

  on<K extends OrchestratorEvent['type']>(type: K, handler: EventHandler<EventMap[K]>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    const typedHandler = handler as EventHandler<OrchestratorEvent>;
    this.handlers.get(type)!.add(typedHandler);

    return () => {
      this.handlers.get(type)?.delete(typedHandler);
    };
  }

  emit<K extends OrchestratorEvent['type']>(event: EventMap[K]): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }
}
