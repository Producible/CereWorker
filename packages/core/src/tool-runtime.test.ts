import { describe, expect, it, vi } from 'vitest';
import { ToolRuntime } from './tool-runtime.js';
import type { ToolDefinition } from './orchestrator.js';

describe('ToolRuntime', () => {
  it('normalizes whitespace in tool names and enforces required parameters in enhanced mode', async () => {
    const runtime = new ToolRuntime({
      engine: 'enhanced',
    });

    const tools = new Map<string, ToolDefinition>([
      ['searchFiles', {
        description: 'Search files',
        parameters: {
          pattern: { type: 'string', required: true },
        },
        execute: vi.fn(async () => 'ok'),
      }],
    ]);

    const execution = await runtime.execute({
      toolCall: {
        id: 'call-1',
        name: '  searchFiles  ',
        args: {},
      },
      tools,
      scopeKey: 'conversation-1',
    });

    expect(execution.toolName).toBe('searchFiles');
    expect(execution.result.isError).toBe(true);
    expect(execution.result.output).toContain('Missing required parameter: pattern');
  });

  it('normalizes structured tool results and truncates oversized output in enhanced mode', async () => {
    const runtime = new ToolRuntime({
      engine: 'enhanced',
      maxResultChars: 40,
    });

    const tools = new Map<string, ToolDefinition>([
      ['inspect', {
        description: 'Inspect something',
        parameters: {},
        execute: vi.fn(async () => ({
          output: 'x'.repeat(80),
          metadata: { source: 'test' },
          details: { kind: 'structured' },
        })),
      }],
    ]);

    const execution = await runtime.execute({
      toolCall: {
        id: 'call-2',
        name: 'inspect',
        args: {},
      },
      tools,
      scopeKey: 'conversation-2',
    });

    expect(execution.result.isError).toBe(false);
    expect(execution.result.metadata).toEqual({ source: 'test' });
    expect(execution.result.details).toEqual({
      kind: 'structured',
      originalOutputChars: 80,
    });
    expect(execution.result.truncated).toBe(true);
    expect(execution.result.output).toContain('[Tool result truncated during persistence and replay.]');
  });

  it('detects repeated tool loops and blocks after the critical threshold', async () => {
    const execute = vi.fn(async () => 'still waiting');
    const runtime = new ToolRuntime({
      engine: 'enhanced',
      loopDetection: {
        enabled: true,
        historySize: 10,
        warningThreshold: 2,
        criticalThreshold: 3,
        globalCircuitBreakerThreshold: 10,
        detectors: {
          genericRepeat: true,
          knownPollNoProgress: false,
          pingPong: false,
        },
      },
    });

    const tools = new Map<string, ToolDefinition>([
      ['query_agents', {
        description: 'Check agent status',
        parameters: {},
        execute,
      }],
    ]);

    const first = await runtime.execute({
      toolCall: { id: 'loop-1', name: 'query_agents', args: {} },
      tools,
      scopeKey: 'loop-scope',
    });
    const second = await runtime.execute({
      toolCall: { id: 'loop-2', name: 'query_agents', args: {} },
      tools,
      scopeKey: 'loop-scope',
    });
    const third = await runtime.execute({
      toolCall: { id: 'loop-3', name: 'query_agents', args: {} },
      tools,
      scopeKey: 'loop-scope',
    });

    expect(first.result.warnings).toBeUndefined();
    expect(second.result.warnings).toEqual([
      expect.stringContaining('Repeated tool calls detected for query_agents'),
    ]);
    expect(third.result.isError).toBe(true);
    expect(third.result.output).toContain('Critical tool loop detected for query_agents');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects tool execution immediately when the abort signal fires', async () => {
    const runtime = new ToolRuntime({
      engine: 'enhanced',
    });
    const abortController = new AbortController();
    const execute = vi.fn(async (_args, context) => {
      expect(context?.abortSignal).toBe(abortController.signal);
      await new Promise(() => {});
      return 'never';
    });

    const tools = new Map<string, ToolDefinition>([
      ['hangTool', {
        description: 'Hang forever',
        parameters: {},
        execute,
      }],
    ]);

    const execution = runtime.execute({
      toolCall: {
        id: 'call-abort',
        name: 'hangTool',
        args: {},
      },
      tools,
      scopeKey: 'abort-scope',
      abortSignal: abortController.signal,
    });

    abortController.abort();

    await expect(execution).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Tool execution aborted',
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
