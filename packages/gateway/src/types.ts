import type { ToolResult, TransportEnvelope } from '@producible/cereworker-core';

export interface NodeStatus {
  healthy: boolean;
  uptime: number;
  activeTools: number;
  autoMode: boolean;
}

export interface SessionInvokeContext {
  callId?: string;
  requestedToolName?: string;
  turnId?: string;
  attempt?: number;
  scopeKey?: string;
}

export interface SessionBusEnvelopeMap {
  'transport.connect': {
    nodeId: string;
    token: string;
    capabilities: string[];
  };
  'transport.connected': {
    gatewayId: string;
  };
  'transport.error': {
    message: string;
  };
  'transport.ack': {
    message?: string;
  };
  'transport.ping': {
    sentAt?: number;
  };
  'transport.pong': {
    sentAt?: number;
  };
  'transport.disconnect': {
    reason: string;
  };
  'transport.emergency-stop': {
    reason?: string;
  };
  'node.status.request': {
    requestId: string;
  };
  'node.status': {
    requestId?: string;
    status: NodeStatus;
  };
  'invoke.request': {
    invocationId: string;
    tool: string;
    args: Record<string, unknown>;
    context?: SessionInvokeContext;
  };
  'invoke.result': {
    invocationId: string;
    result: ToolResult;
  };
  'tool.started': {
    invocationId: string;
    tool: string;
    args: Record<string, unknown>;
    context?: SessionInvokeContext;
    nodeId?: string;
  };
  'tool.finished': {
    invocationId: string;
    tool: string;
    args: Record<string, unknown>;
    result: ToolResult;
    context?: SessionInvokeContext;
    nodeId?: string;
  };
}

export type SessionBusEventType = keyof SessionBusEnvelopeMap;

export type GatewayFrame<K extends SessionBusEventType = SessionBusEventType> = TransportEnvelope<
  SessionBusEnvelopeMap[K]
> & {
  eventType: K;
};

export type AnyGatewayFrame = {
  [K in SessionBusEventType]: GatewayFrame<K>;
}[SessionBusEventType];

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
  stateDir?: string;
  instanceId?: string;
}

export interface GatewayClientConfig {
  gatewayUrl: string;
  nodeId: string;
  token: string;
  capabilities: string[];
  stateDir?: string;
  instanceId?: string;
}
