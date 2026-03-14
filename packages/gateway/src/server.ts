import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { nanoid } from 'nanoid';
import { createLogger } from '@cereworker/core';
import type { GatewayFrame, GatewayServerConfig, NodeInfo } from './types.js';

const log = createLogger('gateway-server');

interface ConnectedNode {
  ws: WebSocket;
  info: NodeInfo;
}

interface PendingInvocation {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          this.send(ws, { type: 'error', message: 'Authentication timeout' });
          ws.close();
        }
      }, 10_000);

      ws.on('message', (data: Buffer) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(data.toString()) as GatewayFrame;
        } catch {
          this.send(ws, { type: 'error', message: 'Invalid JSON' });
          return;
        }

        if (!authenticated) {
          if (frame.type !== 'connect') {
            this.send(ws, { type: 'error', message: 'Must authenticate first' });
            ws.close();
            return;
          }

          clearTimeout(authTimeout);

          if (this.config.token && frame.token !== this.config.token) {
            this.send(ws, { type: 'error', message: 'Invalid token' });
            ws.close();
            return;
          }

          if (this.nodes.has(frame.nodeId)) {
            this.send(ws, { type: 'error', message: `Node "${frame.nodeId}" already connected` });
            ws.close();
            return;
          }

          nodeId = frame.nodeId;
          authenticated = true;

          const info: NodeInfo = {
            nodeId: frame.nodeId,
            capabilities: frame.capabilities,
            connectedAt: Date.now(),
            lastPingAt: Date.now(),
            status: 'connected',
          };

          this.nodes.set(frame.nodeId, { ws, info });
          this.send(ws, { type: 'connected', gatewayId: this.gatewayId });

          log.info('Node connected', { nodeId: frame.nodeId, capabilities: frame.capabilities });
          this.onNodeConnected?.(frame.nodeId, frame.capabilities);
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

    // Reject all pending invocations
    for (const [id, pending] of this.pendingInvocations) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Gateway shutting down'));
    }
    this.pendingInvocations.clear();

    // Close all node connections
    for (const [nodeId, node] of this.nodes) {
      this.send(node.ws, { type: 'disconnect', reason: 'gateway shutting down' });
      node.ws.close();
    }
    this.nodes.clear();

    // Close servers
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

  async invoke(nodeId: string, tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string> {
    const node = this.nodes.get(nodeId);
    if (!node || node.info.status !== 'connected') {
      throw new Error(`Node "${nodeId}" is not connected`);
    }

    const id = nanoid(12);
    const timeout = timeoutMs ?? this.config.invokeTimeoutMs;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvocations.delete(id);
        reject(new Error(`Invoke timeout: ${tool}@${nodeId} after ${timeout}ms`));
      }, timeout);

      this.pendingInvocations.set(id, { resolve, reject, timer });
      this.send(node.ws, { type: 'invoke', id, tool, args });
      log.info('Invoke sent', { id, nodeId, tool });
    });
  }

  emergencyStopAll(): void {
    for (const [nodeId, node] of this.nodes) {
      this.send(node.ws, { type: 'emergency-stop' });
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

  private handleFrame(nodeId: string, frame: GatewayFrame): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    switch (frame.type) {
      case 'invoke-result': {
        const pending = this.pendingInvocations.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingInvocations.delete(frame.id);
          if (frame.isError) {
            pending.reject(new Error(frame.output));
          } else {
            pending.resolve(frame.output);
          }
          log.info('Invoke result received', { id: frame.id, nodeId, isError: frame.isError });
        }
        break;
      }

      case 'pong':
        node.info.lastPingAt = Date.now();
        node.info.status = 'connected';
        break;

      case 'status-response':
        // Status responses are informational; log them
        log.info('Node status', { nodeId, status: frame.status });
        break;

      case 'disconnect':
        this.handleNodeDisconnect(nodeId, frame.reason);
        break;

      default:
        log.warn('Unexpected frame from node', { nodeId, type: frame.type });
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
        } else if (elapsed > staleThreshold) {
          node.info.status = 'stale';
        }

        this.send(node.ws, { type: 'ping' });
      }
    }, this.config.pingIntervalMs);
  }

  private send(ws: WebSocket, frame: GatewayFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }
}
