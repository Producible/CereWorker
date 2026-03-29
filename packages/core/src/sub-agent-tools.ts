import type { ToolDefinition } from './orchestrator.js';
import type { SubAgentManager } from './sub-agent-manager.js';

export function createSubAgentTools(manager: SubAgentManager): Record<string, ToolDefinition> {
  return {
    spawn_agent: {
      description:
        'Spawn a sub-agent to handle a task in the background. Returns the agent ID. The sub-agent has its own isolated memory and conversation.',
      parameters: {
        task: { type: 'string', description: 'The task for the sub-agent to complete', required: true },
        timeoutMinutes: { type: 'number', description: 'Max lifetime in minutes (default: 5, 0 = unlimited)', required: false },
        label: { type: 'string', description: 'Optional short label for the agent', required: false },
        cleanup: {
          type: 'string',
          description: '"delete" to remove after completion, "keep" to persist (default: delete)',
          required: false,
        },
        longRunning: {
          type: 'boolean',
          description: 'Set true for long-running tasks — sets unlimited timeout and keeps session files for recovery',
          required: false,
        },
      },
      execute: async (args) => {
        const { task, timeoutMinutes, label, cleanup, longRunning } = args as {
          task: string;
          timeoutMinutes?: number;
          label?: string;
          cleanup?: string;
          longRunning?: boolean;
        };

        const effectiveTimeout = longRunning ? 0 : (timeoutMinutes || 5) * 60_000;
        const effectiveCleanup = longRunning ? 'keep' : (cleanup === 'keep' ? 'keep' : 'delete');

        try {
          const id = await manager.spawn(task, {
            timeoutMs: effectiveTimeout,
            label,
            cleanup: effectiveCleanup,
          });
          return `Sub-agent ${id} spawned${label ? ` (${label})` : ''}. Use query_agents to check status.`;
        } catch (err) {
          return `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    query_agents: {
      description:
        'Query the status of all sub-agents, or a specific one by ID. Returns status, task, result, and other details.',
      parameters: {
        agentId: { type: 'string', description: 'Optional: query a specific agent by ID', required: false },
      },
      execute: async (args) => {
        const { agentId } = args as { agentId?: string };

        if (agentId) {
          const agent = manager.getAgent(agentId);
          if (!agent) return `Agent ${agentId} not found.`;
          return JSON.stringify(agent, null, 2);
        }

        const agents = manager.listAgents();
        if (agents.length === 0) return 'No sub-agents.';

        const summary = manager.getSummary();
        const header = `${summary.total} agents: ${summary.running} running, ${summary.completed} completed, ${summary.failed} failed\n`;

        const list = agents
          .map((a) => {
            const elapsed = Math.round((Date.now() - a.spawnedAt) / 1000);
            const line = `- [${a.status}] ${a.id}${a.label ? ` (${a.label})` : ''}: ${a.task.slice(0, 80)}${a.task.length > 80 ? '...' : ''} (${elapsed}s)`;
            if (a.progressNote) {
              const pct = a.progressPercent != null ? ` [${a.progressPercent}%]` : '';
              return `${line}\n  Progress: ${a.progressNote}${pct}`;
            }
            if (a.status === 'completed' && a.result) {
              return `${line}\n  Result: ${a.result.slice(0, 200)}${a.result.length > 200 ? '...' : ''}`;
            }
            if (a.error) {
              return `${line}\n  Error: ${a.error}`;
            }
            return line;
          })
          .join('\n');

        return header + list;
      },
    },

    cancel_agent: {
      description: 'Cancel a running sub-agent by ID.',
      parameters: {
        agentId: { type: 'string', description: 'The agent ID to cancel', required: true },
      },
      execute: async (args) => {
        const { agentId } = args as { agentId: string };
        const agent = manager.getAgent(agentId);
        if (!agent) return `Agent ${agentId} not found.`;
        if (agent.status !== 'running' && agent.status !== 'pending') {
          return `Agent ${agentId} is already ${agent.status}.`;
        }
        manager.cancel(agentId);
        return `Agent ${agentId} cancelled.`;
      },
    },
  };
}
