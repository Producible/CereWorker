import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayServer } from './server.js';
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
    senderId: overrides.senderId ?? 'test-sender',
    sessionId: overrides.sessionId ?? 'session-1',
    conversationId: overrides.conversationId,
    source: overrides.source ?? 'node',
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

function connectNode(port: number, nodeId: string, token: string, capabilities: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => {
      sendFrame(ws, makeFrame('transport.connect', { nodeId, token, capabilities }, {
        senderId: nodeId,
        sessionId: `node:${nodeId}`,
        source: 'node',
        sequence: 1,
        resumeFromSequence: 0,
      }));
      waitForFrame(ws, 'transport.connected').then(() => resolve(ws)).catch(reject);
    });
    ws.on('error', reject);
  });
}

describe('GatewayServer', () => {
  let server: GatewayServer;
  let stateDir: string;
  const port = 18900 + Math.floor(Math.random() * 100);
  const token = 'test-secret';

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'gateway-server-state-'));
    server = new GatewayServer({
      port,
      token,
      invokeTimeoutMs: 5000,
      pingIntervalMs: 60000,
      stateDir,
      instanceId: 'instance-1',
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('accepts node connection with valid token', async () => {
    const ws = await connectNode(port, 'worker-1', token, ['shell', 'file']);
    const nodes = server.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeId).toBe('worker-1');
    expect(nodes[0].capabilities).toEqual(['shell', 'file']);
    expect(nodes[0].status).toBe('connected');
    ws.close();
  });

  it('rejects connection with invalid token', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    sendFrame(ws, makeFrame('transport.connect', {
      nodeId: 'bad-node',
      token: 'wrong',
      capabilities: [],
    }, {
      senderId: 'bad-node',
      sessionId: 'node:bad-node',
      source: 'node',
      sequence: 1,
    }));
    const frame = await waitForFrame(ws, 'transport.error');
    expect(frame.payload).toEqual({ message: 'Invalid token' });
    ws.close();
  });

  it('invokes tool on connected node and gets structured result', async () => {
    const ws = await connectNode(port, 'exec-node', token, ['shell']);

    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as AnyGatewayFrame;
      if (frame.eventType === 'invoke.request') {
        sendFrame(ws, makeFrame('invoke.result', {
          invocationId: frame.payload.invocationId,
          result: {
            callId: 'remote-call',
            output: 'hello world',
            isError: false,
          },
        }, {
          senderId: 'exec-node',
          sessionId: frame.sessionId,
          conversationId: frame.conversationId,
          source: 'node',
          sequence: 2,
          ackedThrough: frame.sequence,
        }));
      }
    });

    const result = await server.invoke('exec-node', 'shell', { command: 'echo hello' }, {
      conversationId: 'conv-1',
      sessionId: 'turn-1',
      turnId: 'turn-1',
      attempt: 1,
    });
    expect(result.output).toBe('hello world');
    expect(result.callId).toBe('remote-call');
    ws.close();
  });

});
