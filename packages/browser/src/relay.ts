import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { createLogger } from '@producible/cereworker-core';
import { EventEmitter } from 'node:events';

const log = createLogger('browser-relay');

export interface RelayCommand {
  type: 'command';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RelayResult {
  type: 'result';
  id: string;
  result?: string;
  error?: string;
}

export interface RelayConfig {
  port: number;
  token?: string;
}

interface PendingCommand {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserRelay extends EventEmitter {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private extensionWs: WebSocket | null = null;
  private pending = new Map<string, PendingCommand>();
  private commandId = 0;
  private config: RelayConfig;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RelayConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    this.httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: this.isExtensionConnected() }));
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '/', `http://localhost:${this.config.port}`);

      // Validate path
      if (url.pathname !== '/extension') {
        ws.close(4001, 'Invalid path');
        return;
      }

      // Validate token
      if (this.config.token) {
        const token = url.searchParams.get('token');
        if (token !== this.config.token) {
          ws.close(4003, 'Invalid token');
          return;
        }
      }

      // Only allow one extension connection
      if (this.extensionWs) {
        this.extensionWs.close(4002, 'Replaced by new connection');
      }

      this.extensionWs = ws;
      log.info('Extension connected');
      this.emit('extension:connected');

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as RelayResult;
          if (msg.type === 'result' && msg.id) {
            const pending = this.pending.get(msg.id);
            if (pending) {
              this.pending.delete(msg.id);
              clearTimeout(pending.timer);
              if (msg.error) {
                pending.reject(new Error(msg.error));
              } else {
                pending.resolve(msg.result ?? '');
              }
            }
          }
        } catch {
          log.debug('Invalid message from extension');
        }
      });

      ws.on('close', () => {
        if (this.extensionWs === ws) {
          this.extensionWs = null;
          log.info('Extension disconnected');
          this.emit('extension:disconnected');
          // Reject all pending commands
          for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Extension disconnected'));
            this.pending.delete(id);
          }
        }
      });

      ws.on('error', (err) => {
        log.debug('Extension WebSocket error', { error: err.message });
      });
    });

    // Keepalive ping every 30s
    this.pingTimer = setInterval(() => {
      if (this.extensionWs?.readyState === WebSocket.OPEN) {
        this.extensionWs.ping();
      }
    }, 30_000);

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.config.port, '127.0.0.1', () => {
        log.info('Relay server listening', { port: this.config.port });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.extensionWs) {
      this.extensionWs.close();
      this.extensionWs = null;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Relay stopped'));
      this.pending.delete(id);
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  isExtensionConnected(): boolean {
    return this.extensionWs?.readyState === WebSocket.OPEN;
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      throw new Error('Extension not connected. Load the CereWorker extension in Chrome and check the connection.');
    }

    const id = String(++this.commandId);
    const command: RelayCommand = { type: 'command', id, method, params };

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        this.pending.delete(id);
        reject(createAbortError(`Command ${method} aborted`));
      };

      const cleanup = () => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
      };

      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(id);
        reject(new Error(`Command ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (abortSignal?.aborted) {
        onAbort();
        return;
      }

      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
      });
      this.extensionWs!.send(JSON.stringify(command));
    });
  }
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
