import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { GatewayNodeClient } from './client.js';
import type { GatewayFrame } from './types.js';

function sendFrame(ws: WebSocket, frame: GatewayFrame): void {
  ws.send(JSON.stringify(frame));
}

function waitForFrame(ws: WebSocket, type?: string): Promise<GatewayFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for frame')), 5000);
    ws.on('message', function handler(data: Buffer) {
      const frame = JSON.parse(data.toString()) as GatewayFrame;
      if (!type || frame.type === type) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(frame);
      }
    });
  });
}

describe('GatewayNodeClient', () => {
  let wss: WebSocketServer;
  const port = 19000 + Math.floor(Math.random() * 100);

  beforeEach(() => {
    wss = new WebSocketServer({ port });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('connects and sends handshake', async () => {
    const handshakePromise = new Promise<GatewayFrame>((resolve) => {
      wss.on('connection', (ws) => {
        waitForFrame(ws, 'connect').then((frame) => {
          sendFrame(ws, { type: 'connected', gatewayId: 'gw-1' });
          resolve(frame);
        });
      });
    });

    const client = new GatewayNodeClient(
      { gatewayUrl: `ws://localhost:${port}`, nodeId: 'node-1', token: 'secret', capabilities: ['shell'] },
      async () => '',
    );
    await client.connect();

    const frame = await handshakePromise;
    expect(frame.type).toBe('connect');
    expect((frame as any).nodeId).toBe('node-1');
    expect((frame as any).token).toBe('secret');
    expect((frame as any).capabilities).toEqual(['shell']);
    expect(client.isConnected()).toBe(true);

    await client.disconnect();
  });

  it('handles invoke from gateway', async () => {
    let serverWs: WebSocket;

    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as GatewayFrame;
        if (frame.type === 'connect') {
          sendFrame(ws, { type: 'connected', gatewayId: 'gw-1' });
        }
      });
    });

    const client = new GatewayNodeClient(
      { gatewayUrl: `ws://localhost:${port}`, nodeId: 'node-2', token: 'secret', capabilities: ['shell'] },
      async (tool, args) => {
        expect(tool).toBe('shell');
        expect(args).toEqual({ command: 'ls' });
        return 'file1\nfile2';
      },
    );
    await client.connect();

    // Wait for server to have the ws reference
    await new Promise((r) => setTimeout(r, 50));

    // Send invoke from "gateway"
    sendFrame(serverWs!, { type: 'invoke', id: 'inv-1', tool: 'shell', args: { command: 'ls' } });
    const result = await waitForFrame(serverWs!, 'invoke-result');
    expect(result.type).toBe('invoke-result');
    expect((result as any).id).toBe('inv-1');
    expect((result as any).output).toBe('file1\nfile2');
    expect((result as any).isError).toBe(false);

    await client.disconnect();
  });

  it('handles invoke error', async () => {
    let serverWs: WebSocket;

    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as GatewayFrame;
        if (frame.type === 'connect') {
          sendFrame(ws, { type: 'connected', gatewayId: 'gw-1' });
        }
      });
    });

    const client = new GatewayNodeClient(
      { gatewayUrl: `ws://localhost:${port}`, nodeId: 'node-3', token: 'secret', capabilities: ['shell'] },
      async () => {
        throw new Error('exec failed');
      },
    );
    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    sendFrame(serverWs!, { type: 'invoke', id: 'inv-2', tool: 'shell', args: {} });
    const result = await waitForFrame(serverWs!, 'invoke-result');
    expect((result as any).isError).toBe(true);
    expect((result as any).output).toBe('exec failed');

    await client.disconnect();
  });

  it('responds to ping with pong', async () => {
    let serverWs: WebSocket;

    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as GatewayFrame;
        if (frame.type === 'connect') {
          sendFrame(ws, { type: 'connected', gatewayId: 'gw-1' });
        }
      });
    });

    const client = new GatewayNodeClient(
      { gatewayUrl: `ws://localhost:${port}`, nodeId: 'node-4', token: 'secret', capabilities: [] },
      async () => '',
    );
    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    sendFrame(serverWs!, { type: 'ping' });
    const pong = await waitForFrame(serverWs!, 'pong');
    expect(pong.type).toBe('pong');

    await client.disconnect();
  });

  it('calls emergency stop handler', async () => {
    let serverWs: WebSocket;
    let emergencyCalled = false;

    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as GatewayFrame;
        if (frame.type === 'connect') {
          sendFrame(ws, { type: 'connected', gatewayId: 'gw-1' });
        }
      });
    });

    const client = new GatewayNodeClient(
      { gatewayUrl: `ws://localhost:${port}`, nodeId: 'node-5', token: 'secret', capabilities: [] },
      async () => '',
    );
    client.setEmergencyStopHandler(() => {
      emergencyCalled = true;
    });
    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    sendFrame(serverWs!, { type: 'emergency-stop' });
    await new Promise((r) => setTimeout(r, 50));
    expect(emergencyCalled).toBe(true);

    await client.disconnect();
  });
});
