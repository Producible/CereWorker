export interface NodeStatus {
  healthy: boolean;
  uptime: number;
  activeTools: number;
  autoMode: boolean;
}

export type GatewayFrame =
  | { type: 'connect'; nodeId: string; token: string; capabilities: string[] }
  | { type: 'connected'; gatewayId: string }
  | { type: 'error'; message: string }
  | { type: 'invoke'; id: string; tool: string; args: Record<string, unknown> }
  | { type: 'invoke-result'; id: string; output: string; isError: boolean }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'status-request'; id: string }
  | { type: 'status-response'; id: string; status: NodeStatus }
  | { type: 'emergency-stop' }
  | { type: 'disconnect'; reason: string };

export interface NodeInfo {
  nodeId: string;
  capabilities: string[];
  connectedAt: number;
  lastPingAt: number;
  status: 'connected' | 'stale' | 'disconnected';
}

export interface GatewayServerConfig {
  port: number;
  token?: string;
  invokeTimeoutMs: number;
  pingIntervalMs: number;
}

export interface GatewayClientConfig {
  gatewayUrl: string;
  nodeId: string;
  token: string;
  capabilities: string[];
}
