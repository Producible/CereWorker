import { describe, it, expect, vi } from 'vitest';
import { createProxyTools } from './proxy-tools.js';
import type { GatewayServer } from './server.js';
import type { ToolResult } from '@producible/cereworker-core';

function mockServer(
  invokeResult: ToolResult = { callId: 'call-1', output: 'ok', isError: false },
): GatewayServer {
  return {
    invoke: vi.fn().mockResolvedValue(invokeResult),
  } as unknown as GatewayServer;
}

describe('createProxyTools', () => {
  it('creates tool entries for each capability', () => {
    const server = mockServer();
    const tools = createProxyTools(server, 'worker-1', ['shell', 'file', 'browser']);

    expect(Object.keys(tools)).toEqual(['shell@worker-1', 'file@worker-1', 'browser@worker-1']);
  });

  it('tool names follow cap@nodeId pattern', () => {
    const server = mockServer();
    const tools = createProxyTools(server, 'my-gpu', ['shell']);

    expect(tools['shell@my-gpu']).toBeDefined();
    expect(tools['shell@my-gpu'].description).toContain('shell');
    expect(tools['shell@my-gpu'].description).toContain('my-gpu');
  });

  it('tool execute calls server.invoke with correct args', async () => {
    const server = mockServer({ callId: 'call-1', output: 'result-data', isError: false });
    const tools = createProxyTools(server, 'worker-1', ['shell']);

    const result = await tools['shell@worker-1'].execute({ command: 'ls -la' });

    expect(result).toEqual({ callId: 'call-1', output: 'result-data', isError: false });
    expect(server.invoke).toHaveBeenCalledWith('worker-1', 'shell', { command: 'ls -la' }, {
      conversationId: undefined,
      sessionId: undefined,
      turnId: undefined,
      attempt: undefined,
      callId: undefined,
      requestedToolName: undefined,
      scopeKey: undefined,
    });
  });

  it('forwards tool execution context into server.invoke options', async () => {
    const server = mockServer();
    const tools = createProxyTools(server, 'worker-1', ['shell']);

    await tools['shell@worker-1'].execute(
      { command: 'pwd' },
      {
        callId: 'call-42',
        toolName: 'shell@worker-1',
        conversationId: 'conv-1',
        sessionKey: 'session-1',
        scopeKey: 'scope-1',
        turnId: 'turn-1',
        attempt: 3,
        runtimeEngine: 'enhanced',
      },
    );

    expect(server.invoke).toHaveBeenCalledWith('worker-1', 'shell', { command: 'pwd' }, {
      conversationId: 'conv-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      attempt: 3,
      callId: 'call-42',
      requestedToolName: 'shell@worker-1',
      scopeKey: 'scope-1',
    });
  });

  it('returns empty object for empty capabilities', () => {
    const server = mockServer();
    const tools = createProxyTools(server, 'worker-1', []);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('propagates invoke errors', async () => {
    const server = {
      invoke: vi.fn().mockRejectedValue(new Error('node offline')),
    } as unknown as GatewayServer;

    const tools = createProxyTools(server, 'worker-1', ['shell']);
    await expect(tools['shell@worker-1'].execute({})).rejects.toThrow('node offline');
  });
});
