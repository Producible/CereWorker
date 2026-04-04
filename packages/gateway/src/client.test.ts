import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayNodeClient } from './client.js';
import type { AnyGatewayFrame } from './types.js';
import { TRANSPORT_PROTOCOL_VERSION } from './session-bus.js';

function makeFrame(
  eventType: AnyGatewayFrame['eventType'],
  payload: AnyGatewayFrame['payload'],
  overrides: Partial<AnyGatewayFrame> = {},
): AnyGatewayFrame {
  return {
    envelopeId: overrides.envelopeId ?? `${eventType}-${Math.random()}`,
    protocolVersion: TRANSPORT_PROTOCOL_VERSION,
    senderId: overrides.senderId ?? 'gateway-1',
    sessionId: overrides.sessionId ?? 'session-1',
    conversationId: overrides.conversationId,
    source: overrides.source ?? 'gateway',
    eventType,
    timestamp: overrides.timestamp ?? Date.now(),
    payload,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
    ...(overrides.ackedThrough !== undefined ? { ackedThrough: overrides.ackedThrough } : {}),
    ...(overrides.resumeFromSequence !== undefined
      ? { resumeFromSequence: overrides.resumeFromSequence }
      : {}),
  } as AnyGatewayFrame;
}

function sendFrame(ws: WebSocket, frame: AnyGatewayFrame): void {
  ws.send(JSON.stringify(frame));
}

function waitForFrame(
  ws: WebSocket,
  eventType?: AnyGatewayFrame['eventType'],
  predicate?: (frame: AnyGatewayFrame) => boolean,
): Promise<AnyGatewayFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for frame')), 5000);
    ws.on('message', function handler(data: Buffer) {
      const frame = JSON.parse(data.toString()) as AnyGatewayFrame;
      if ((!eventType || frame.eventType === eventType) && (!predicate || predicate(frame))) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(frame);
      }
    });
  });
}

async function waitForCondition(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('GatewayNodeClient', () => {
  let wss: WebSocketServer;
  let stateDir: string;
  let activeClient: GatewayNodeClient | null = null;
  const port = 19000 + Math.floor(Math.random() * 100);

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'gateway-client-state-'));
    wss = new WebSocketServer({ port });
  });

  afterEach(async () => {
    if (activeClient) {
      await activeClient.disconnect();
      activeClient = null;
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('connects and sends handshake', async () => {
    const handshakePromise = new Promise<AnyGatewayFrame>((resolve) => {
      wss.on('connection', (ws) => {
        waitForFrame(ws, 'transport.connect').then((frame) => {
          sendFrame(ws, makeFrame('transport.connected', { gatewayId: 'gw-1' }, {
            sequence: 1,
            resumeFromSequence: 0,
          }));
          resolve(frame);
        });
      });
    });

    const client = new GatewayNodeClient(
      {
        gatewayUrl: `ws://localhost:${port}`,
        nodeId: 'node-1',
        token: 'secret',
        capabilities: ['shell'],
        stateDir,
      },
      async () => '',
    );
    activeClient = client;
    await client.connect();

    const frame = await handshakePromise;
    expect(frame.eventType).toBe('transport.connect');
    expect(frame.payload).toMatchObject({
      nodeId: 'node-1',
      token: 'secret',
      capabilities: ['shell'],
    });
    expect(client.isConnected()).toBe(true);
  });

  it('handles invoke request and emits node tool lifecycle + result', async () => {
    let serverWs: WebSocket;

    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as AnyGatewayFrame;
        if (frame.eventType === 'transport.connect') {
          sendFrame(ws, makeFrame('transport.connected', { gatewayId: 'gw-1' }, {
            sequence: 1,
            resumeFromSequence: 0,
          }));
        }
      });
    });

    const client = new GatewayNodeClient(
      {
        gatewayUrl: `ws://localhost:${port}`,
        nodeId: 'node-2',
        token: 'secret',
        capabilities: ['shell'],
        stateDir,
      },
      async (tool, args, context) => {
        expect(tool).toBe('shell');
        expect(args).toEqual({ command: 'ls' });
        expect(context?.conversationId).toBe('conv-1');
        expect(context?.sessionId).toBe('turn-1');
        return {
          callId: context?.callId ?? 'call-1',
          output: 'file1\nfile2',
          isError: false,
        };
      },
    );
    activeClient = client;
    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const startedPromise = waitForFrame(serverWs!, 'tool.started');
    const finishedPromise = waitForFrame(serverWs!, 'tool.finished');
    const resultPromise = waitForFrame(serverWs!, 'invoke.result');
    sendFrame(serverWs!, makeFrame('invoke.request', {
      invocationId: 'inv-1',
      tool: 'shell',
      args: { command: 'ls' },
      context: {
        callId: 'remote-call',
        turnId: 'turn-1',
        attempt: 1,
      },
    }, {
      sessionId: 'turn-1',
      conversationId: 'conv-1',
      source: 'gateway',
      sequence: 2,
    }));

    const started = await startedPromise;
    expect(started.payload.invocationId).toBe('inv-1');
    const finished = await finishedPromise;
    expect(finished.payload.result.output).toBe('file1\nfile2');
    const result = await resultPromise;
    expect(result.payload.result.isError).toBe(false);
    expect(result.payload.result.callId).toBe('remote-call');
  });

  it('replays unacked node envelopes after reconnect', async () => {
    const connectionFrames: AnyGatewayFrame[][] = [];
    let connectionCount = 0;

    wss.on('connection', (ws) => {
      const frames: AnyGatewayFrame[] = [];
      connectionFrames.push(frames);
      connectionCount++;
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as AnyGatewayFrame;
        frames.push(frame);
        if (frame.eventType === 'transport.connect') {
          sendFrame(ws, makeFrame('transport.connected', { gatewayId: 'gw-1' }, {
            sequence: 1,
            resumeFromSequence: 0,
          }));
          if (connectionCount === 1) {
            sendFrame(ws, makeFrame('invoke.request', {
              invocationId: 'inv-2',
              tool: 'shell',
              args: { command: 'pwd' },
              context: {
                callId: 'remote-call-2',
                turnId: 'turn-2',
                attempt: 1,
              },
            }, {
              sessionId: 'turn-2',
              conversationId: 'conv-2',
              source: 'gateway',
              sequence: 2,
            }));
          }
        }
      });
    });

    const client = new GatewayNodeClient(
      {
        gatewayUrl: `ws://localhost:${port}`,
        nodeId: 'node-3',
        token: 'secret',
        capabilities: ['shell'],
        stateDir,
      },
      async () => ({
        callId: 'remote-call-2',
        output: '/tmp',
        isError: false,
      }),
    );
    activeClient = client;

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    wss.clients.forEach((ws) => ws.close());
    await waitForCondition(() => connectionFrames.length >= 2, 5000);
    await waitForCondition(() => {
      const replayedFrames = connectionFrames[1] ?? [];
      return replayedFrames.some((frame) => frame.eventType === 'tool.started')
        && replayedFrames.some((frame) => frame.eventType === 'invoke.result');
    }, 5000);

    const replayed = connectionFrames.at(-1)?.filter((frame) =>
      ['tool.started', 'tool.finished', 'invoke.result'].includes(frame.eventType),
    );
    expect(replayed?.some((frame) => frame.eventType === 'tool.started')).toBe(true);
    expect(replayed?.some((frame) => frame.eventType === 'invoke.result')).toBe(true);

  });

  it('calls emergency stop handler', async () => {
    let serverWs: WebSocket;
    let emergencyCalled = false;

    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as AnyGatewayFrame;
        if (frame.eventType === 'transport.connect') {
          sendFrame(ws, makeFrame('transport.connected', { gatewayId: 'gw-1' }, {
            sequence: 1,
            resumeFromSequence: 0,
          }));
        }
      });
    });

    const client = new GatewayNodeClient(
      {
        gatewayUrl: `ws://localhost:${port}`,
        nodeId: 'node-4',
        token: 'secret',
        capabilities: [],
        stateDir,
      },
      async () => '',
    );
    activeClient = client;
    client.setEmergencyStopHandler(() => {
      emergencyCalled = true;
    });
    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    sendFrame(serverWs!, makeFrame('transport.emergency-stop', { reason: 'test' }, {
      sequence: 2,
    }));
    await new Promise((r) => setTimeout(r, 50));
    expect(emergencyCalled).toBe(true);
  });
});
