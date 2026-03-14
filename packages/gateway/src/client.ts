import WebSocket from 'ws';
import { createLogger } from '@cereworker/core';
import type { GatewayFrame, GatewayClientConfig, NodeStatus } from './types.js';

const log = createLogger('gateway-client');

export type ToolExecutor = (tool: string, args: Record<string, unknown>) => Promise<string>;

export class GatewayNodeClient {
  private ws: WebSocket | null = null;
  private config: GatewayClientConfig;
  private executor: ToolExecutor;
  private onEmergencyStop?: () => void;
  private reconnectAttempt = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private stopped = false;
  private startedAt = Date.now();

  constructor(config: GatewayClientConfig, executor: ToolExecutor) {
    this.config = config;
    this.executor = executor;
  }

  setEmergencyStopHandler(handler: () => void): void {
    this.onEmergencyStop = handler;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.startedAt = Date.now();
    return this.doConnect();
  }

  async disconnect(reason = 'client shutdown'): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.send({ type: 'disconnect', reason });
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    log.info('Disconnected from gateway', { reason });
  }

  isConnected(): boolean {
    return this.connected;
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.gatewayUrl);

      ws.on('open', () => {
        this.ws = ws;
        this.send({
          type: 'connect',
          nodeId: this.config.nodeId,
          token: this.config.token,
          capabilities: this.config.capabilities,
        });
      });

      ws.on('message', (data: Buffer) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(data.toString()) as GatewayFrame;
        } catch {
          log.warn('Received invalid JSON from gateway');
          return;
        }

        this.handleFrame(frame, resolve, reject);
      });

      ws.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.ws = null;

        if (!this.stopped) {
          log.warn('Connection to gateway lost, reconnecting...');
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        log.error('WebSocket error', { error: err.message });
        if (!this.connected) {
          reject(err);
        }
      });
    });
  }

  private handleFrame(frame: GatewayFrame, onConnect?: (value: void) => void, onError?: (err: Error) => void): void {
    switch (frame.type) {
      case 'connected':
        this.connected = true;
        this.reconnectAttempt = 0;
        log.info('Connected to gateway', { gatewayId: frame.gatewayId, nodeId: this.config.nodeId });
        onConnect?.();
        break;

      case 'error':
        log.error('Gateway error', { message: frame.message });
        if (!this.connected) {
          onError?.(new Error(frame.message));
        }
        break;

      case 'invoke':
        this.handleInvoke(frame.id, frame.tool, frame.args);
        break;

      case 'ping':
        this.send({ type: 'pong' });
        break;

      case 'status-request':
        this.send({
          type: 'status-response',
          id: frame.id,
          status: this.getStatus(),
        });
        break;

      case 'emergency-stop':
        log.warn('Emergency stop received from gateway');
        this.onEmergencyStop?.();
        break;

      case 'disconnect':
        log.info('Gateway requested disconnect', { reason: frame.reason });
        this.stopped = true;
        this.ws?.close();
        break;

      default:
        log.warn('Unexpected frame from gateway', { type: frame.type });
    }
  }

  private async handleInvoke(id: string, tool: string, args: Record<string, unknown>): Promise<void> {
    log.info('Invoke received', { id, tool });
    try {
      const output = await this.executor(tool, args);
      this.send({ type: 'invoke-result', id, output, isError: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'invoke-result', id, output: message, isError: true });
    }
  }

  private getStatus(): NodeStatus {
    return {
      healthy: true,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      activeTools: this.config.capabilities.length,
      autoMode: false,
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectAttempt >= this.maxReconnectAttempts) {
      if (this.reconnectAttempt >= this.maxReconnectAttempts) {
        log.error('Max reconnect attempts reached, giving up');
      }
      return;
    }

    const baseDelay = 1000;
    const maxDelay = 30_000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempt), maxDelay);
    const jitter = delay * (0.5 + Math.random() * 0.5);

    this.reconnectAttempt++;
    log.info('Reconnecting...', { attempt: this.reconnectAttempt, delayMs: Math.round(jitter) });

    this.reconnectTimer = setTimeout(() => {
      this.doConnect().catch((err) => {
        log.error('Reconnect failed', { error: err.message });
      });
    }, jitter);
  }

  private send(frame: GatewayFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}
