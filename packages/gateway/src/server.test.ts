import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { GatewayServer } from './server.js';
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

function connectNode(port: number, nodeId: string, token: string, capabilities: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => {
      sendFrame(ws, { type: 'connect', nodeId, token, capabilities });
      waitForFrame(ws, 'connected').then(() => resolve(ws)).catch(reject);
    });
    ws.on('error', reject);
  });
}

describe('GatewayServer', () => {
  let server: GatewayServer;
  const port = 18900 + Math.floor(Math.random() * 100);
  const token = 'test-secret';

  beforeEach(async () => {
    server = new GatewayServer({
      port,
      token,
      invokeTimeoutMs: 5000,
      pingIntervalMs: 60000, // high to avoid interfering with tests
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
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
    sendFrame(ws, { type: 'connect', nodeId: 'bad-node', token: 'wrong', capabilities: [] });
    const frame = await waitForFrame(ws, 'error');
    expect(frame.type).toBe('error');
    expect((frame as { message: string }).message).toBe('Invalid token');
    ws.close();
  });

  it('rejects duplicate nodeId', async () => {
    const ws1 = await connectNode(port, 'dup-node', token, ['shell']);
    const ws2 = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws2.on('open', resolve));
    sendFrame(ws2, { type: 'connect', nodeId: 'dup-node', token, capabilities: ['shell'] });
    const frame = await waitForFrame(ws2, 'error');
    expect((frame as { message: string }).message).toContain('already connected');
    ws1.close();
    ws2.close();
  });

  it('invokes tool on connected node and gets result', async () => {
    const ws = await connectNode(port, 'exec-node', token, ['shell']);

    // Listen for invoke on the node side
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as GatewayFrame;
      if (frame.type === 'invoke') {
        sendFrame(ws, {
          type: 'invoke-result',
          id: frame.id,
          output: 'hello world',
          isError: false,
        });
      }
    });

    const result = await server.invoke('exec-node', 'shell', { command: 'echo hello' });
    expect(result).toBe('hello world');
    ws.close();
  });

  it('rejects invoke on unknown node', async () => {
    await expect(server.invoke('nonexistent', 'shell', {})).rejects.toThrow('not connected');
  });

  it('times out invoke when node does not respond', async () => {
    const ws = await connectNode(port, 'slow-node', token, ['shell']);
    // Do not respond to invoke
    await expect(server.invoke('slow-node', 'shell', {}, 200)).rejects.toThrow('timeout');
    ws.close();
  });

  it('sends emergency stop to all nodes', async () => {
    const ws = await connectNode(port, 'stop-node', token, ['shell']);
    const framePromise = waitForFrame(ws, 'emergency-stop');
    server.emergencyStopAll();
    const frame = await framePromise;
    expect(frame.type).toBe('emergency-stop');
    ws.close();
  });

  it('removes node on disconnect and calls handler with capabilities', async () => {
    let disconnectedId: string | undefined;
    let disconnectedCaps: string[] | undefined;
    server.setNodeDisconnectedHandler((nodeId, _reason, capabilities) => {
      disconnectedId = nodeId;
      disconnectedCaps = capabilities;
    });

    const ws = await connectNode(port, 'disc-node', token, ['shell', 'file']);
    expect(server.listNodes()).toHaveLength(1);
    ws.close();

    // Wait for disconnect to propagate
    await new Promise((r) => setTimeout(r, 100));
    expect(server.listNodes()).toHaveLength(0);
    expect(disconnectedId).toBe('disc-node');
    expect(disconnectedCaps).toEqual(['shell', 'file']);
  });

  it('calls node connected handler', async () => {
    let connectedNodeId: string | undefined;
    let connectedCaps: string[] | undefined;
    server.setNodeConnectedHandler((nodeId, caps) => {
      connectedNodeId = nodeId;
      connectedCaps = caps;
    });

    const ws = await connectNode(port, 'handler-node', token, ['shell', 'file']);
    expect(connectedNodeId).toBe('handler-node');
    expect(connectedCaps).toEqual(['shell', 'file']);
    ws.close();
  });

  it('serves HTTP /status endpoint', async () => {
    const ws = await connectNode(port, 'status-node', token, ['shell']);
    const res = await fetch(`http://localhost:${port}/status`);
    const body = await res.json();
    expect(body.gatewayId).toBe(server.getGatewayId());
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].nodeId).toBe('status-node');
    ws.close();
  });

  it('handles invoke error from node', async () => {
    const ws = await connectNode(port, 'err-node', token, ['shell']);

    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as GatewayFrame;
      if (frame.type === 'invoke') {
        sendFrame(ws, {
          type: 'invoke-result',
          id: frame.id,
          output: 'command failed',
          isError: true,
        });
      }
    });

    await expect(server.invoke('err-node', 'shell', { command: 'bad' })).rejects.toThrow('command failed');
    ws.close();
  });
});
