import { describe, it, expect, vi } from 'vitest';
import { createSubAgentTools } from './sub-agent-tools.js';
import type { SubAgentManager } from './sub-agent-manager.js';

function mockManager(overrides: Partial<SubAgentManager> = {}) {
  return {
    spawn: vi.fn().mockResolvedValue('agent-1'),
    getAgent: vi.fn().mockReturnValue(null),
    listAgents: vi.fn().mockReturnValue([]),
    getSummary: vi.fn().mockReturnValue({ total: 0, running: 0, completed: 0, failed: 0 }),
    cancel: vi.fn(),
    ...overrides,
  } as unknown as SubAgentManager;
}

describe('createSubAgentTools', () => {
  it('returns spawn_agent, query_agents, and cancel_agent', () => {
    const tools = createSubAgentTools(mockManager());
    expect(tools.spawn_agent).toBeDefined();
    expect(tools.query_agents).toBeDefined();
    expect(tools.cancel_agent).toBeDefined();
  });

  describe('spawn_agent', () => {
    it('calls manager.spawn and returns success message', async () => {
      const mgr = mockManager();
      const tools = createSubAgentTools(mgr);
      const result = await tools.spawn_agent.execute({ task: 'do stuff', timeoutMinutes: 10 });
      expect(mgr.spawn).toHaveBeenCalledWith('do stuff', expect.objectContaining({
        timeoutMs: 600000,
      }));
      expect(result).toContain('agent-1');
      expect(result).toContain('spawned');
    });

    it('includes label in response', async () => {
      const tools = createSubAgentTools(mockManager());
      const result = await tools.spawn_agent.execute({ task: 'research', label: 'researcher' });
      expect(result).toContain('researcher');
    });

    it('returns error message on spawn failure', async () => {
      const mgr = mockManager({ spawn: vi.fn().mockRejectedValue(new Error('max reached')) } as any);
      const tools = createSubAgentTools(mgr);
      const result = await tools.spawn_agent.execute({ task: 'x' });
      expect(result).toContain('Failed to spawn');
      expect(result).toContain('max reached');
    });

    it('converts timeout from minutes to ms', async () => {
      const mgr = mockManager();
      const tools = createSubAgentTools(mgr);
      await tools.spawn_agent.execute({ task: 't', timeoutMinutes: 3 });
      expect(mgr.spawn).toHaveBeenCalledWith('t', expect.objectContaining({
        timeoutMs: 180000,
      }));
    });
  });

  describe('query_agents', () => {
    it('returns specific agent as JSON', async () => {
      const agent = {
        id: 'a1', task: 'test', status: 'running', label: 'lab',
        spawnedAt: Date.now(), lastActivityAt: Date.now(), timeoutMs: 300000,
        messagesCount: 5, toolCallsCount: 2, retryCount: 0,
        sessionKey: 'k', parentSessionKey: 'p', cleanup: 'delete', memoryDir: '/tmp',
      };
      const mgr = mockManager({ getAgent: vi.fn().mockReturnValue(agent) } as any);
      const tools = createSubAgentTools(mgr);
      const result = await tools.query_agents.execute({ agentId: 'a1' });
      expect(result).toContain('"id": "a1"');
      expect(result).toContain('"status": "running"');
    });

    it('returns not found for missing agent', async () => {
      const tools = createSubAgentTools(mockManager());
      const result = await tools.query_agents.execute({ agentId: 'missing' });
      expect(result).toContain('not found');
    });

    it('returns summary and list for all agents', async () => {
      const agents = [
        { id: 'a1', task: 'task one', status: 'running', spawnedAt: Date.now(), label: undefined, result: undefined, error: undefined },
        { id: 'a2', task: 'task two', status: 'completed', spawnedAt: Date.now(), result: 'done', label: undefined, error: undefined },
      ];
      const summary = { total: 2, running: 1, completed: 1, failed: 0 };
      const mgr = mockManager({
        listAgents: vi.fn().mockReturnValue(agents),
        getSummary: vi.fn().mockReturnValue(summary),
      } as any);
      const tools = createSubAgentTools(mgr);
      const result = await tools.query_agents.execute({});
      expect(result).toContain('2 agents');
      expect(result).toContain('1 running');
      expect(result).toContain('task one');
      expect(result).toContain('task two');
    });

    it('returns empty message when no agents', async () => {
      const tools = createSubAgentTools(mockManager());
      const result = await tools.query_agents.execute({});
      expect(result).toBe('No sub-agents.');
    });

    it('truncates long tasks', async () => {
      const longTask = 'x'.repeat(200);
      const agents = [{ id: 'a1', task: longTask, status: 'running', spawnedAt: Date.now(), label: undefined, result: undefined, error: undefined }];
      const mgr = mockManager({
        listAgents: vi.fn().mockReturnValue(agents),
        getSummary: vi.fn().mockReturnValue({ total: 1, running: 1, completed: 0, failed: 0 }),
      } as any);
      const tools = createSubAgentTools(mgr);
      const result = await tools.query_agents.execute({});
      expect(result).toContain('...');
    });
  });

  describe('cancel_agent', () => {
    it('cancels a running agent', async () => {
      const agent = { id: 'a1', status: 'running' };
      const mgr = mockManager({ getAgent: vi.fn().mockReturnValue(agent) } as any);
      const tools = createSubAgentTools(mgr);
      const result = await tools.cancel_agent.execute({ agentId: 'a1' });
      expect(mgr.cancel).toHaveBeenCalledWith('a1');
      expect(result).toContain('cancelled');
    });

    it('returns not found for missing agent', async () => {
      const tools = createSubAgentTools(mockManager());
      const result = await tools.cancel_agent.execute({ agentId: 'missing' });
      expect(result).toContain('not found');
    });

    it('returns already-status for completed agent', async () => {
      const agent = { id: 'a1', status: 'completed' };
      const mgr = mockManager({ getAgent: vi.fn().mockReturnValue(agent) } as any);
      const tools = createSubAgentTools(mgr);
      const result = await tools.cancel_agent.execute({ agentId: 'a1' });
      expect(result).toContain('already completed');
      expect(mgr.cancel).not.toHaveBeenCalled();
    });
  });
});
