import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { nanoid } from 'nanoid';
import { createLogger, type ToolResult } from '@cereworker/core';
import type {
  AnyGatewayFrame,
  GatewayFrame,
  GatewayServerConfig,
  NodeInfo,
  SessionBusEnvelopeMap,
  SessionBusEventType,
  SessionInvokeContext,
} from './types.js';
import { SessionBusState, buildBusStatePath } from './session-bus.js';

const log = createLogger('gateway-server');

interface ConnectedNode {
  ws: WebSocket;
  info: NodeInfo;
  bus: SessionBusState;
}

interface PendingInvocation {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  nodeId: string;
  tool: string;
}

export class GatewayServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private nodes = new Map<string, ConnectedNode>();
  private pendingInvocations = new Map<string, PendingInvocation>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private gatewayId: string;
  private config: GatewayServerConfig;

  private onNodeConnected?: (nodeId: string, capabilities: string[]) => void;
  private onNodeDisconnected?: (nodeId: string, reason: string, capabilities: string[]) => void;
  private onEnvelope?: (nodeId: string, frame: AnyGatewayFrame) => void;

  constructor(config: GatewayServerConfig) {
    this.config = config;
    this.gatewayId = nanoid(12);
  }

  setNodeConnectedHandler(handler: (nodeId: string, capabilities: string[]) => void): void {
    this.onNodeConnected = handler;
  }

  setNodeDisconnectedHandler(handler: (nodeId: string, reason: string, capabilities: string[]) => void): void {
    this.onNodeDisconnected = handler;
  }

  setEnvelopeHandler(handler: (nodeId: string, frame: AnyGatewayFrame) => void): void {
    this.onEnvelope = handler;
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ gatewayId: this.gatewayId, nodes: this.listNodes() }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws: WebSocket) => {
      let authenticated = false;
      let nodeId: string | null = null;
      let nodeBus: SessionBusState | null = null;

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          this.sendRaw(ws, this.createServerEnvelope('transport.error', {
            sessionId: 'gateway',
            source: 'gateway',
            payload: { message: 'Authentication timeout' },
          }));
          ws.close();
        }
      }, 10_000);

      ws.on('message', (data: Buffer) => {
        let frame: AnyGatewayFrame;
        try {
          frame = JSON.parse(data.toString()) as AnyGatewayFrame;
        } catch {
          this.sendRaw(ws, this.createServerEnvelope('transport.error', {
            sessionId: 'gateway',
            source: 'gateway',
            payload: { message: 'Invalid JSON' },
          }));
          return;
        }

        if (!authenticated) {
          if (frame.eventType !== 'transport.connect') {
            this.sendRaw(ws, this.createServerEnvelope('transport.error', {
              sessionId: 'gateway',
              source: 'gateway',
              payload: { message: 'Must authenticate first' },
            }));
            ws.close();
            return;
          }

          clearTimeout(authTimeout);

          const { nodeId: requestedNodeId, token, capabilities } = frame.payload;
          if (this.config.token && token !== this.config.token) {
            this.sendRaw(ws, this.createServerEnvelope('transport.error', {
              sessionId: 'gateway',
              source: 'gateway',
              payload: { message: 'Invalid token' },
            }));
            ws.close();
            return;
          }

          if (this.nodes.has(requestedNodeId)) {
            this.sendRaw(ws, this.createServerEnvelope('transport.error', {
              sessionId: 'gateway',
              source: 'gateway',
              payload: { message: `Node "${requestedNodeId}" already connected` },
            }));
            ws.close();
            return;
          }

          nodeId = requestedNodeId;
          nodeBus = new SessionBusState(
            buildBusStatePath(this.config.stateDir, `gateway-${requestedNodeId}`, requestedNodeId),
          );
          nodeBus.markReceived(frame);
          authenticated = true;

          const info: NodeInfo = {
            nodeId: requestedNodeId,
            capabilities,
            connectedAt: Date.now(),
            lastPingAt: Date.now(),
            status: 'connected',
          };

          this.nodes.set(requestedNodeId, { ws, info, bus: nodeBus });
          this.sendEnvelope(this.nodes.get(requestedNodeId)!, 'transport.connected', {
            sessionId: 'gateway',
            source: 'gateway',
            payload: { gatewayId: this.gatewayId },
            resumeFromSequence: nodeBus.getHighestReceivedSequence(),
          });

          const replayFrom = frame.resumeFromSequence ?? 0;
          for (const pending of nodeBus.replayAfter(replayFrom)) {
            this.sendRaw(ws, pending);
          }

          log.info('Node connected', { nodeId: requestedNodeId, capabilities, replayFrom });
          this.onNodeConnected?.(requestedNodeId, capabilities);
          return;
        }

        this.handleFrame(nodeId!, frame);
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        if (nodeId) {
          this.handleNodeDisconnect(nodeId, 'connection closed');
        }
      });

      ws.on('error', (err: Error) => {
        log.error('WebSocket error', { nodeId, error: err.message });
        if (nodeId) {
          this.handleNodeDisconnect(nodeId, `error: ${err.message}`);
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.config.port, () => {
        log.info('Gateway server started', { port: this.config.port, gatewayId: this.gatewayId });
        resolve();
      });
    });

    this.startPingLoop();
  }

  async stop(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    for (const [id, pending] of this.pendingInvocations) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Gateway shutting down'));
      this.pendingInvocations.delete(id);
    }

    for (const [, node] of this.nodes) {
      this.sendEnvelope(node, 'transport.disconnect', {
        sessionId: 'gateway',
        source: 'gateway',
        payload: { reason: 'gateway shutting down' },
      });
      node.ws.close();
    }
    this.nodes.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    await new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
        this.httpServer = null;
      } else {
        resolve();
      }
    });

    log.info('Gateway server stopped');
  }

  async invoke(
    nodeId: string,
    tool: string,
    args: Record<string, unknown>,
    options?: {
      timeoutMs?: number;
      conversationId?: string;
      sessionId?: string;
      turnId?: string;
      attempt?: number;
      callId?: string;
      requestedToolName?: string;
      scopeKey?: string;
    },
  ): Promise<ToolResult> {
    const node = this.nodes.get(nodeId);
    if (!node || node.info.status !== 'connected') {
      throw new Error(`Node "${nodeId}" is not connected`);
    }

    const invocationId = nanoid(12);
    const timeout = options?.timeoutMs ?? this.config.invokeTimeoutMs;
    const context: SessionInvokeContext = {
      callId: options?.callId,
      requestedToolName: options?.requestedToolName,
      turnId: options?.turnId,
      attempt: options?.attempt,
      scopeKey: options?.scopeKey,
    };

    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvocations.delete(invocationId);
        reject(new Error(`Invoke timeout: ${tool}@${nodeId} after ${timeout}ms`));
      }, timeout);

      this.pendingInvocations.set(invocationId, {
        resolve,
        reject,
        timer,
        nodeId,
        tool,
      });

      this.sendEnvelope(node, 'invoke.request', {
        sessionId: options?.sessionId ?? options?.turnId ?? `node:${nodeId}`,
        conversationId: options?.conversationId,
        source: 'gateway',
        payload: {
          invocationId,
          tool,
          args,
          context,
        },
      });
      log.info('Invoke sent', {
        invocationId,
        nodeId,
        tool,
        sessionId: options?.sessionId ?? options?.turnId ?? `node:${nodeId}`,
      });
    });
  }

  emergencyStopAll(): void {
    for (const [nodeId, node] of this.nodes) {
      this.sendEnvelope(node, 'transport.emergency-stop', {
        sessionId: 'gateway',
        source: 'gateway',
        payload: { reason: 'gateway emergency stop' },
      });
      log.warn('Emergency stop sent to node', { nodeId });
    }
  }

  listNodes(): NodeInfo[] {
    return Array.from(this.nodes.values()).map((n) => ({ ...n.info }));
  }

  getNode(nodeId: string): NodeInfo | undefined {
    return this.nodes.get(nodeId)?.info;
  }

  getGatewayId(): string {
    return this.gatewayId;
  }

  getPort(): number {
    return this.config.port;
  }

  private createServerEnvelope<K extends SessionBusEventType>(
    eventType: K,
    options: {
      sessionId: string;
      conversationId?: string;
      source: GatewayFrame<K>['source'];
      payload: SessionBusEnvelopeMap[K];
      resumeFromSequence?: number;
    },
  ): GatewayFrame<K> {
    const bus = new SessionBusState(null);
    return bus.createEnvelope({
      eventType,
      senderId: this.gatewayId,
      instanceId: this.config.instanceId,
      sessionId: options.sessionId,
      conversationId: options.conversationId,
      source: options.source,
      payload: options.payload,
      resumeFromSequence: options.resumeFromSequence,
    });
  }

  private handleFrame(nodeId: string, frame: AnyGatewayFrame): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const shouldProcess = node.bus.markReceived(frame);
    if (frame.eventType !== 'transport.ack') {
      this.sendEnvelope(node, 'transport.ack', {
        sessionId: frame.sessionId,
        conversationId: frame.conversationId,
        source: 'gateway',
        payload: { message: 'ack' },
      });
    }
    if (!shouldProcess) return;

    switch (frame.eventType) {
      case 'invoke.result': {
        const pending = this.pendingInvocations.get(frame.payload.invocationId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingInvocations.delete(frame.payload.invocationId);
          if (frame.payload.result.isError) {
            pending.reject(new Error(frame.payload.result.output));
          } else {
            pending.resolve(frame.payload.result);
          }
          log.info('Invoke result received', {
            invocationId: frame.payload.invocationId,
            nodeId,
            isError: frame.payload.result.isError,
          });
        }
        this.onEnvelope?.(nodeId, frame);
        break;
      }

      case 'tool.started':
      case 'tool.finished':
      case 'node.status':
        if (frame.eventType === 'node.status') {
          node.info.lastPingAt = Date.now();
          node.info.status = 'connected';
        }
        this.onEnvelope?.(nodeId, frame);
        break;

      case 'transport.pong':
        node.info.lastPingAt = Date.now();
        node.info.status = 'connected';
        break;

      case 'transport.disconnect':
        this.handleNodeDisconnect(nodeId, frame.payload.reason);
        break;

      default:
        log.warn('Unexpected frame from node', { nodeId, eventType: frame.eventType });
    }
  }

  private handleNodeDisconnect(nodeId: string, reason: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const capabilities = [...node.info.capabilities];
    node.info.status = 'disconnected';
    this.nodes.delete(nodeId);

    log.info('Node disconnected', { nodeId, reason });
    this.onNodeDisconnected?.(nodeId, reason, capabilities);
  }

  private startPingLoop(): void {
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      const staleThreshold = this.config.pingIntervalMs * 3;
      const disconnectThreshold = this.config.pingIntervalMs * 6;

      for (const [nodeId, node] of this.nodes) {
        const elapsed = now - node.info.lastPingAt;

        if (elapsed > disconnectThreshold) {
          log.warn('Node timed out', { nodeId, elapsedMs: elapsed });
          this.handleNodeDisconnect(nodeId, 'ping timeout');
          node.ws.close();
          continue;
        }
        if (elapsed > staleThreshold) {
          node.info.status = 'stale';
        }

        this.sendEnvelope(node, 'transport.ping', {
          sessionId: 'gateway',
          source: 'gateway',
          payload: { sentAt: Date.now() },
        });
      }
    }, this.config.pingIntervalMs);
  }

  private sendEnvelope<K extends SessionBusEventType>(
    node: ConnectedNode,
    eventType: K,
    options: {
      sessionId: string;
      conversationId?: string;
      source: GatewayFrame<K>['source'];
      payload: SessionBusEnvelopeMap[K];
      resumeFromSequence?: number;
    },
  ): GatewayFrame<K> {
    const envelope = node.bus.createEnvelope({
      eventType,
      senderId: this.gatewayId,
      instanceId: this.config.instanceId,
      sessionId: options.sessionId,
      conversationId: options.conversationId,
      source: options.source,
      payload: options.payload,
      resumeFromSequence: options.resumeFromSequence,
    });
    this.sendRaw(node.ws, envelope as AnyGatewayFrame);
    return envelope;
  }

  private sendRaw(ws: WebSocket, frame: AnyGatewayFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }
}
