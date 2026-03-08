import type { Message, ToolCall, ToolResult, TaskAction, CerebellumStatus } from './types.js';

export type OrchestratorEvent =
  | { type: 'message:user'; message: Message }
  | { type: 'message:cerebrum:start'; conversationId: string }
  | { type: 'message:cerebrum:chunk'; chunk: string }
  | { type: 'message:cerebrum:end'; message: Message }
  | { type: 'message:cerebrum:toolcall'; toolCall: ToolCall }
  | { type: 'tool:start'; callId: string; name: string }
  | { type: 'tool:end'; result: ToolResult }
  | { type: 'heartbeat:tick'; actions: TaskAction[] }
  | { type: 'cerebellum:status'; status: CerebellumStatus }
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
