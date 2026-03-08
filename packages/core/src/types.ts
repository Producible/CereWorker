export type MessageRole = 'user' | 'cerebrum' | 'cerebellum' | 'tool' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  output: string;
  isError: boolean;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskAction {
  taskId: string;
  action: 'invoke' | 'skip' | 'defer' | 'cancel';
  reason: string;
}

export interface CerebellumStatus {
  healthy: boolean;
  modelName: string;
  uptimeSeconds: number;
  tasksRegistered: number;
}

export interface OrchestratorConfig {
  cerebrum: {
    defaultProvider: string;
    defaultModel: string;
  };
  cerebellum: {
    enabled: boolean;
    address: string;
  };
}
