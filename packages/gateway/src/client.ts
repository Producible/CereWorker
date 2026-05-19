import WebSocket from 'ws';
import { createLogger, type ToolResult } from '@producible/cereworker-core';
import type {
  AnyGatewayFrame,
  GatewayClientConfig,
  SessionBusEnvelopeMap,
  SessionBusEventType,
} from './types.js';
import { SessionBusState, buildBusStatePath } from './session-bus.js';

const log = createLogger('gateway-client');

export interface RemoteToolExecutionContext {
  conversationId?: string;
  sessionId: string;
  turnId?: string;
  attempt?: number;
  scopeKey?: string;
  callId?: string;
}

export type ToolExecutor = (
  tool: string,
  args: Record<string, unknown>,
  context?: RemoteToolExecutionContext,
) => Promise<string | ToolResult>;

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
  private readonly bus: SessionBusState;

  constructor(config: GatewayClientConfig, executor: ToolExecutor) {
    this.config = config;
    this.executor = executor;
    this.bus = new SessionBusState(
      buildBusStatePath(
        config.stateDir,
        `node-${config.nodeId}`,
        `${config.gatewayUrl}-${config.nodeId}`,
      ),
    );
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
      this.sendEnvelope('transport.disconnect', {
        sessionId: `node:${this.config.nodeId}`,
        source: 'node',
        payload: { reason },
      });
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
        this.sendEnvelope('transport.connect', {
          sessionId: `node:${this.config.nodeId}`,
          source: 'node',
          payload: {
            nodeId: this.config.nodeId,
            token: this.config.token,
            capabilities: this.config.capabilities,
          },
          resumeFromSequence: this.bus.getResumeSequence(),
        });
      });

      ws.on('message', (data: Buffer) => {
        let frame: AnyGatewayFrame;
        try {
          frame = JSON.parse(data.toString()) as AnyGatewayFrame;
        } catch {
          log.warn('Received invalid JSON from gateway');
          return;
        }

        const isConnectedFrame = frame.eventType === 'transport.connected';
        if (isConnectedFrame) {
          this.bus.markConnected(frame);
        }
        const shouldProcess = isConnectedFrame ? true : this.bus.markReceived(frame);
        if (frame.eventType !== 'transport.ack') {
          this.sendEnvelope('transport.ack', {
            sessionId: frame.sessionId,
            conversationId: frame.conversationId,
            source: 'node',
            payload: { message: 'ack' },
          });
        }
        if (!shouldProcess) return;

        this.handleFrame(frame, resolve, reject);
      });

      ws.on('close', () => {
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

  private handleFrame(frame: AnyGatewayFrame, onConnect?: (value: void) => void, onError?: (err: Error) => void): void {
    switch (frame.eventType) {
      case 'transport.connected':
        this.connected = true;
        this.reconnectAttempt = 0;
        for (const pending of this.bus.replayAfter(frame.resumeFromSequence ?? 0)) {
          this.sendRaw(pending);
        }
        log.info('Connected to gateway', { gatewayId: frame.payload.gatewayId, nodeId: this.config.nodeId });
        onConnect?.();
        break;

      case 'transport.error':
        log.error('Gateway error', { message: frame.payload.message });
        if (!this.connected) {
          onError?.(new Error(frame.payload.message));
        }
        break;

      case 'invoke.request':
        void this.handleInvoke(frame);
        break;

      case 'transport.ping':
        this.sendEnvelope('transport.pong', {
          sessionId: frame.sessionId,
          conversationId: frame.conversationId,
          source: 'node',
          payload: { sentAt: frame.payload.sentAt },
        });
        break;

      case 'node.status.request':
        this.sendEnvelope('node.status', {
          sessionId: frame.sessionId,
          conversationId: frame.conversationId,
          source: 'node',
          payload: {
            requestId: frame.payload.requestId,
            status: this.getStatus(),
          },
        });
        break;

      case 'transport.emergency-stop':
        log.warn('Emergency stop received from gateway');
        this.onEmergencyStop?.();
        break;

      case 'transport.disconnect':
        log.info('Gateway requested disconnect', { reason: frame.payload.reason });
        this.stopped = true;
        this.ws?.close();
        break;

      default:
        log.warn('Unexpected frame from gateway', { eventType: frame.eventType });
    }
  }

  private async handleInvoke(frame: AnyGatewayFrame & { eventType: 'invoke.request' }): Promise<void> {
    const { invocationId, tool, args, context } = frame.payload;
    log.info('Invoke received', { invocationId, tool });

    this.sendEnvelope('tool.started', {
      sessionId: frame.sessionId,
      conversationId: frame.conversationId,
      source: 'node',
      payload: {
        invocationId,
        tool,
        args,
        context,
        nodeId: this.config.nodeId,
      },
    });

    let result: ToolResult;
    try {
      const rawResult = await this.executor(tool, args, {
        conversationId: frame.conversationId,
        sessionId: frame.sessionId,
        turnId: context?.turnId ?? frame.sessionId,
        attempt: context?.attempt,
        scopeKey: context?.scopeKey,
        callId: context?.callId ?? invocationId,
      });
      result = this.normalizeResult(rawResult, context?.callId ?? invocationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        callId: context?.callId ?? invocationId,
        output: message,
        isError: true,
        metadata: {
          runtimeError: true,
        },
      };
    }

    this.sendEnvelope('tool.finished', {
      sessionId: frame.sessionId,
      conversationId: frame.conversationId,
      source: 'node',
      payload: {
        invocationId,
        tool,
        args,
        result,
        context,
        nodeId: this.config.nodeId,
      },
    });
    this.sendEnvelope('invoke.result', {
      sessionId: frame.sessionId,
      conversationId: frame.conversationId,
      source: 'node',
      payload: {
        invocationId,
        result,
      },
    });
  }

  private normalizeResult(raw: string | ToolResult, callId: string): ToolResult {
    if (typeof raw === 'string') {
      return {
        callId,
        output: raw,
        isError: false,
      };
    }
    return {
      ...raw,
      callId: raw.callId || callId,
    };
  }

  private getStatus() {
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

  private sendEnvelope<K extends SessionBusEventType>(
    eventType: K,
    options: {
      sessionId: string;
      conversationId?: string;
      source: AnyGatewayFrame['source'];
      payload: SessionBusEnvelopeMap[K];
      resumeFromSequence?: number;
    },
  ): AnyGatewayFrame {
    const envelope = this.bus.createEnvelope({
      eventType,
      senderId: this.config.nodeId,
      instanceId: this.config.instanceId,
      sessionId: options.sessionId,
      conversationId: options.conversationId,
      source: options.source,
      payload: options.payload,
      resumeFromSequence: options.resumeFromSequence,
    });
    this.sendRaw(envelope as AnyGatewayFrame);
    return envelope as AnyGatewayFrame;
  }

  private sendRaw(frame: AnyGatewayFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}
