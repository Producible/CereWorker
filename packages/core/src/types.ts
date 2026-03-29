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
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  truncated?: boolean;
  synthetic?: boolean;
  warnings?: string[];
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

export interface VerificationCheck {
  name: string;
  passed: boolean;
  description: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  modelVerdict: boolean;
  toolCallId: string;
  toolName: string;
}

export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
export type SubAgentCleanup = 'delete' | 'keep';

export interface SubAgentState {
  id: string;
  sessionKey: string;
  parentSessionKey: string;
  task: string;
  label?: string;
  status: SubAgentStatus;
  cleanup: SubAgentCleanup;
  spawnedAt: number;
  lastActivityAt: number;
  timeoutMs: number;
  result?: string;
  error?: string;
  messagesCount: number;
  toolCallsCount: number;
  retryCount: number;
  memoryDir: string;
}

export interface SubAgentSummary {
  total: number;
  running: number;
  completed: number;
  failed: number;
}

export interface AgentHealthAction {
  agentId: string;
  action: 'ok' | 'ping' | 'retry' | 'cancel' | 'timeout';
  reason: string;
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
