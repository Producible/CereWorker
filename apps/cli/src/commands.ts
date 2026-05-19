import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatTaskSchedule, getNextTaskRun, type Orchestrator } from '@producible/cereworker-core';
import type { CerebrumProvider } from '@producible/cereworker-cerebrum';
import type { ChannelManager } from '@producible/cereworker-channels';
import type { SkillRegistry } from '@producible/cereworker-skills';
import type { CereWorkerConfig } from '@producible/cereworker-config';
import type { GatewayServer, GatewayNodeClient } from '@producible/cereworker-gateway';
import type { ServiceInstance } from './service.js';
import { formatLocalTimestamp } from './presentation.js';

export interface CommandContext {
  orchestrator: Orchestrator;
  cerebrum: CerebrumProvider;
  channelManager: ChannelManager;
  skillRegistry: SkillRegistry;
  config: CereWorkerConfig;
  service: ServiceInstance;
  gatewayServer?: GatewayServer | null;
  gatewayClient?: GatewayNodeClient | null;
  currentModel: string;
  currentProvider: string;
  autoMode: boolean;
}

export type CommandResult =
  | { type: 'message'; text: string; sticky?: boolean }
  | { type: 'tuiOnly' }
  | { type: 'unknown' }
  | { type: 'async'; promise: Promise<string> };

export const SLASH_COMMANDS: Array<{ name: string; hint: string }> = [
  { name: '/agents', hint: 'manage sub-agents' },
  { name: '/approve', hint: 'approve pairing code' },
  { name: '/auth', hint: 'authenticate provider' },
  { name: '/auto', hint: 'toggle auto mode' },
  { name: '/channels', hint: 'list channels' },
  { name: '/clear', hint: 'new conversation' },
  { name: '/config', hint: 'show config' },
  { name: '/conversations', hint: 'list conversations' },
  { name: '/exit', hint: 'quit' },
  { name: '/finetune', hint: 'fine-tune controls' },
  { name: '/help', hint: 'show help' },
  { name: '/memory', hint: 'show memory' },
  { name: '/model', hint: 'switch model' },
  { name: '/nodes', hint: 'gateway nodes' },
  { name: '/pairing', hint: 'list pairings' },
  { name: '/provider', hint: 'switch provider' },
  { name: '/quit', hint: 'quit' },
  { name: '/resume', hint: 'resume conversation' },
  { name: '/skills', hint: 'list skills' },
  { name: '/stop', hint: 'emergency stop' },
  { name: '/task', hint: 'scheduled tasks' },
  { name: '/tasks', hint: 'cerebellum heartbeat tasks' },
];

const COMMANDS_WITH_ARGS = new Set(['model', 'provider', 'auto', 'agents', 'finetune', 'task']);

/** Commands available on IM channels (excludes TUI-only commands). */
export const CHANNEL_COMMANDS: Array<{ name: string; description: string; hasArgs?: boolean }> = SLASH_COMMANDS
  .filter((c) => !['clear', 'exit', 'quit', 'resume', 'approve', 'pairing', 'auth'].includes(c.name.slice(1)))
  .map((c) => {
    const name = c.name.slice(1);
    return { name, description: c.hint, ...(COMMANDS_WITH_ARGS.has(name) ? { hasArgs: true } : {}) };
  });

/** Parse a raw message into command + args. Returns null if not a slash command. */
export function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const command = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
  return { command, args };
}

/**
 * Handle a slash command. Returns a result that both TUI and channels can use.
 * TUI-only commands return { type: 'tuiOnly' }.
 */
export function handleSlashCommand(command: string, args: string, ctx: CommandContext): CommandResult {
  const { orchestrator, cerebrum, channelManager, skillRegistry, config, service } = ctx;

  switch (command) {
    // --- TUI-only commands ---
    case 'quit':
    case 'exit':
    case 'clear':
    case 'resume':
    case 'approve':
    case 'pairing':
    case 'auth':
      return { type: 'tuiOnly' };

    // --- Shared commands ---
    case 'help':
      return {
        type: 'message',
        text: `Available commands:
  /model [name]         Show or switch the current model
  /provider [name]      Show or switch the current provider
  /agents [sub]         Sub-agents: list, stop <id|all>, info <id>
  /memory               Show MEMORY.md contents
  /skills               List loaded skills
  /config               Show current configuration
  /conversations        List past conversations
  /channels             Show channel status
  /nodes                Show connected nodes
  /auto [on|off]        Toggle auto mode
  /finetune [sub]       Fine-tuning: start, status, config, history
  /task [sub]           Scheduled tasks: list, run <id>, history <id>
  /tasks                List Cerebellum heartbeat tasks
  /stop                 Emergency stop
  /clear                Start a new conversation (TUI only)
  /resume <id>          Resume a conversation (TUI only)
  /help                 Show this help
  /quit                 Exit (TUI only)`,
      };

    case 'model':
      if (args.trim()) {
        cerebrum.setModel(args.trim());
        return { type: 'message', text: `Model switched to: ${args.trim()}` };
      }
      return { type: 'message', text: `Current model: ${ctx.currentModel}` };

    case 'provider':
      if (args.trim()) {
        cerebrum.setProvider(args.trim());
        return { type: 'message', text: `Provider switched to: ${args.trim()}` };
      }
      return { type: 'message', text: `Current provider: ${ctx.currentProvider}` };

    case 'auto': {
      const arg = args.trim().toLowerCase();
      if (arg === 'on') {
        orchestrator.setAutoMode(true);
        return { type: 'message', text: 'Auto mode ENABLED. Commands execute without approval.' };
      } else if (arg === 'off') {
        orchestrator.setAutoMode(false);
        return { type: 'message', text: 'Auto mode DISABLED. Unknown commands require approval.' };
      }
      return { type: 'message', text: `Auto mode: ${ctx.autoMode ? 'ON' : 'OFF'}. Usage: /auto [on|off]` };
    }

    case 'channels': {
      const connected = channelManager.listConnected();
      const all = channelManager.list();
      const info = all.map((ch) => `  ${ch.meta.emoji} ${ch.meta.name}: ${ch.isConnected() ? 'connected' : 'offline'}`).join('\n');
      return { type: 'message', text: `Channels (${connected.length}/${all.length} connected):\n${info || '  (none registered)'}` };
    }

    case 'agents': {
      const mgr = orchestrator.getSubAgentManager();
      if (!mgr) return { type: 'message', text: 'Sub-agents are not enabled.' };

      const agentArgs = args.trim().split(/\s+/);
      const agentSub = agentArgs[0] || '';
      const agentTarget = agentArgs[1] || '';

      if (agentSub === 'stop') {
        if (agentTarget === 'all') {
          const agents = mgr.listAgents().filter((a) => a.status === 'running' || a.status === 'pending');
          agents.forEach((a) => mgr.cancel(a.id));
          return { type: 'message', text: `Stopped ${agents.length} agent(s).` };
        }
        if (agentTarget) {
          const agent = mgr.listAgents().find((a) => a.id.startsWith(agentTarget));
          if (!agent) return { type: 'message', text: `Agent "${agentTarget}" not found.` };
          mgr.cancel(agent.id);
          return { type: 'message', text: `Stopped agent ${agent.id}${agent.label ? ` (${agent.label})` : ''}.` };
        }
        return { type: 'message', text: 'Usage: /agents stop <id|all>' };
      }

      if (agentSub === 'info' && agentTarget) {
        const agent = mgr.listAgents().find((a) => a.id.startsWith(agentTarget));
        if (!agent) return { type: 'message', text: `Agent "${agentTarget}" not found.` };
        const elapsed = Math.round((Date.now() - agent.spawnedAt) / 1000);
        const deadline = agent.deadlineAt > 0
          ? `${Math.round((agent.deadlineAt - Date.now()) / 60000)}m remaining`
          : 'unlimited';
        const lines = [
          `Agent: ${agent.id}${agent.label ? ` (${agent.label})` : ''}`,
          `Status: ${agent.status}`,
          `Task: ${agent.task}`,
          `Elapsed: ${elapsed}s | Timeout: ${deadline}`,
          `Messages: ${agent.messagesCount} | Tool calls: ${agent.toolCallsCount} | Retries: ${agent.retryCount}`,
        ];
        if (agent.progressNote) {
          const pct = agent.progressPercent != null ? ` [${agent.progressPercent}%]` : '';
          lines.push(`Progress: ${agent.progressNote}${pct}`);
        }
        if (agent.result) lines.push(`Result: ${agent.result.slice(0, 300)}`);
        if (agent.error) lines.push(`Error: ${agent.error}`);
        return { type: 'message', text: lines.join('\n') };
      }

      // Default: list
      const summary = mgr.getSummary();
      const agents = mgr.listAgents();
      const lines = [`Agents: ${summary.total} total, ${summary.running} running, ${summary.completed} completed, ${summary.failed} failed`];
      for (const a of agents.slice(0, 15)) {
        const elapsed = Math.round((Date.now() - a.spawnedAt) / 1000);
        const elapsedStr = elapsed >= 60 ? `${Math.round(elapsed / 60)}m` : `${elapsed}s`;
        let line = `  [${a.status}] ${a.label ?? a.id} - ${a.task.slice(0, 60)} (${elapsedStr})`;
        if (a.progressNote) {
          const pct = a.progressPercent != null ? ` [${a.progressPercent}%]` : '';
          line += `\n    Progress: ${a.progressNote}${pct}`;
        }
        lines.push(line);
      }
      return { type: 'message', text: lines.join('\n') };
    }

    case 'memory': {
      const memPath = join(config.hippocampus.directory.replace('~', homedir()), 'MEMORY.md');
      try {
        if (existsSync(memPath)) {
          const content = readFileSync(memPath, 'utf-8');
          return { type: 'message', text: `--- MEMORY.md ---\n${content.slice(0, 2000)}` };
        }
        return { type: 'message', text: 'No MEMORY.md found.' };
      } catch {
        return { type: 'message', text: 'Failed to read MEMORY.md' };
      }
    }

    case 'skills': {
      const skills = skillRegistry.list();
      if (skills.length === 0) return { type: 'message', text: 'No skills loaded.' };
      const lines = skills.map((s) => {
        const emoji = s.metadata?.cereworker?.emoji ?? '';
        return `  ${emoji} ${s.name} - ${s.description}`;
      });
      return { type: 'message', text: `Loaded skills (${skills.length}):\n${lines.join('\n')}` };
    }

    case 'config': {
      const lines = [
        `Provider: ${ctx.currentProvider}`,
        `Model: ${ctx.currentModel}`,
        `Temperature: ${config.cerebrum.temperature}`,
        `Max steps: ${config.cerebrum.maxSteps}`,
        `Cerebellum: ${config.cerebellum.enabled ? 'enabled' : 'disabled'}`,
        `Hippocampus: ${config.hippocampus.enabled ? config.hippocampus.directory : 'disabled'}`,
        `Sub-agents: ${config.subAgents.enabled ? `max ${config.subAgents.maxConcurrent}` : 'disabled'}`,
        `Logging: ${config.logging.level}${config.logging.file ? ` -> ${config.logging.file}` : ''}`,
      ];
      return { type: 'message', text: `Configuration:\n${lines.map((l) => `  ${l}`).join('\n')}` };
    }

    case 'conversations': {
      const store = orchestrator.getConversationStore();
      const convs = store.list().slice(0, 20);
      if (convs.length === 0) return { type: 'message', text: 'No conversations found.' };
      const activeId = orchestrator.getActiveConversationId();
      const lines = convs.map((c) => {
        const date = formatLocalTimestamp(c.updatedAt);
        const preview = store.getPreview(c.id)?.slice(0, 50) ?? '(empty)';
        const marker = c.id === activeId ? ' *' : '';
        return `  ${c.id.slice(0, 8)}${marker} | ${date} | ${preview}`;
      });
      return { type: 'message', text: `Conversations (${convs.length}):\n${lines.join('\n')}`, sticky: true };
    }

    case 'nodes': {
      const gwMode = config.gateway.mode;
      if (gwMode === 'gateway' && ctx.gatewayServer) {
        const nodes = ctx.gatewayServer.listNodes();
        if (nodes.length === 0) return { type: 'message', text: 'No nodes connected.' };
        const lines = nodes.map((n) => {
          const elapsed = Math.round((Date.now() - n.connectedAt) / 1000);
          return `  ${n.nodeId} (${n.status}, ${n.capabilities.length} tools, ${elapsed}s)`;
        });
        return { type: 'message', text: `Connected nodes (${nodes.length}):\n${lines.join('\n')}` };
      } else if (gwMode === 'node' && ctx.gatewayClient) {
        return { type: 'message', text: `Node mode: ${ctx.gatewayClient.isConnected() ? 'connected' : 'disconnected'} to ${config.gateway.gatewayUrl}` };
      }
      return { type: 'message', text: 'Gateway not active. Set gateway.mode in config.' };
    }

    case 'stop':
      orchestrator.emergencyStop();
      ctx.gatewayServer?.emergencyStopAll();
      return { type: 'message', text: 'Emergency stop triggered. All operations aborted.' };

    case 'finetune': {
      const ftArgs = args.trim().split(/\s+/);
      const ftSub = ftArgs[0] || '';

      if (ftSub === 'start') {
        return {
          type: 'async',
          promise: orchestrator.triggerFineTune()
            .then(() => 'Fine-tuning started.')
            .catch((err: Error) => `Fine-tune error: ${err.message}`),
        };
      } else if (ftSub === 'status' || ftSub === '') {
        return {
          type: 'async',
          promise: orchestrator.getFineTuneStatus().then((st) => {
            const lines = [
              `Status: ${st.status}`,
              st.jobId ? `Job: ${st.jobId}` : null,
              st.status === 'running' ? `Progress: ${Math.round(st.progress * 100)}% (step ${st.currentStep}/${st.totalSteps})` : null,
              st.currentLoss ? `Loss: ${st.currentLoss.toFixed(4)}` : null,
              st.checkpointPath ? `Checkpoint: ${st.checkpointPath}` : null,
              st.error ? `Error: ${st.error}` : null,
            ].filter(Boolean);
            return `Fine-Tuning Status:\n  ${lines.join('\n  ')}`;
          }).catch((err: Error) => `Fine-tune status error: ${err.message}`),
        };
      } else if (ftSub === 'config') {
        const configKey = ftArgs[1] || '';
        const configVal = ftArgs[2] || '';
        if (configKey === 'method' && configVal) {
          const valid = ['auto', 'lora', 'qlora', 'full'];
          if (valid.includes(configVal)) {
            orchestrator.setFineTuneMethod(configVal);
            return { type: 'message', text: `Fine-tune method set to: ${configVal}` };
          }
          return { type: 'message', text: `Invalid method. Valid: ${valid.join(', ')}` };
        } else if (configKey === 'schedule' && configVal) {
          const valid = ['auto', 'hourly', 'daily', 'weekly'];
          if (valid.includes(configVal)) {
            orchestrator.setFineTuneSchedule(configVal);
            return { type: 'message', text: `Fine-tune schedule set to: ${configVal}` };
          }
          return { type: 'message', text: `Invalid schedule. Valid: ${valid.join(', ')}` };
        }
        return {
          type: 'message',
          text: `Fine-Tune Config:\n  Method: ${orchestrator.getFineTuneMethod()}\n  Schedule: ${orchestrator.getFineTuneSchedule()}\n\nUsage: /finetune config method|schedule <value>`,
        };
      } else if (ftSub === 'history') {
        const history = orchestrator.getFineTuneHistory();
        if (history.length === 0) return { type: 'message', text: 'No fine-tune history yet.' };
        const lines = history.slice(-10).map((h) => {
          const date = formatLocalTimestamp(h.completedAt);
          return `  ${h.jobId} | ${h.status} | loss: ${h.loss.toFixed(4)} | ${date}`;
        });
        return { type: 'message', text: `Fine-Tune History (last ${lines.length}):\n${lines.join('\n')}`, sticky: true };
      }
      return {
        type: 'message',
        text: 'Usage: /finetune [start|status|config|history]',
      };
    }

    case 'task': {
      const taskArgs = args.trim().split(/\s+/);
      const taskSub = taskArgs[0] || '';
      const taskTarget = taskArgs[1] || '';

      if (taskSub === 'run' && taskTarget) {
        return {
          type: 'async',
          promise: service.runTask(taskTarget).then((result) =>
            result.success ? `Task "${taskTarget}" completed.` : `Task "${taskTarget}" failed: ${result.error}`,
          ),
        };
      } else if (taskSub === 'history' && taskTarget) {
        const runs = service.getTaskRuns(taskTarget);
        if (runs.length === 0) return { type: 'message', text: `No run history for task "${taskTarget}".` };
        const lines = runs.slice(-10).map((run) => {
          const completed = run.completedAt ? formatLocalTimestamp(run.completedAt) : 'in progress';
          return `  ${run.status.padEnd(8)} | ${completed}\n    ${run.summary}`;
        });
        return { type: 'message', text: `Task "${taskTarget}" — last ${lines.length} runs:\n${lines.join('\n')}`, sticky: true };
      } else if (taskSub === '' || taskSub === 'list') {
        const tasks = service.getTaskDefinitions().filter((task) => task.enabled);
        if (tasks.length === 0) return { type: 'message', text: 'No active scheduled tasks.' };
        const lines = tasks.map((task) => {
          const running = task.lastResult === 'running' || orchestrator.isTaskRunning(task.id) ? ' [RUNNING]' : '';
          const nextRun = getNextTaskRun(task.schedule, new Date(), {
            lastRunAt: task.lastRunAt,
            timezone: task.timezone,
          });
          const lastRun = task.lastRunAt
            ? `last: ${formatLocalTimestamp(task.lastRunAt)}, runs: ${task.runCount ?? 0}`
            : 'never run';
          const scheduler = task.schedulerStatus ?? (task.enabled ? 'pending_cerebellum' : 'disabled');
          const executionSurface = task.executionSurface ?? 'either';
          return `  ${task.id} (${task.kind}, ${formatTaskSchedule(task.schedule)})${running}\n    ${task.goal.split('\n')[0]}\n    scheduler: ${scheduler}; execution: ${executionSurface}; ${lastRun}; next: ${nextRun ? formatLocalTimestamp(nextRun.toISOString()) : 'n/a'}`;
        });
        return { type: 'message', text: `Scheduled Tasks:\n${lines.join('\n')}`, sticky: true };
      }
      return { type: 'message', text: 'Usage: /task [list|run|history]\n  /task run <id>     Manually trigger a task\n  /task history <id> Show recent run history' };
    }

    case 'tasks': {
      return {
        type: 'async',
        promise: service.listHeartbeatTasks().then((tasks) => {
          if (tasks.length === 0) return 'No heartbeat tasks registered with Cerebellum.';
          const lines = tasks.map((t) => {
            const lastRun = t.lastRun ? formatLocalTimestamp(t.lastRun * 1000) : 'never';
            const meta = t.metadata?.type ? ` [${t.metadata.type}]` : '';
            return `  ${t.taskId.slice(0, 8)} | ${t.status.padEnd(9)} | ${t.scheduleHint}${meta}\n    ${t.description}\n    Last run: ${lastRun}`;
          });
          return `Cerebellum Heartbeat Tasks (${tasks.length}):\n${lines.join('\n')}`;
        }).catch((err: Error) => `Failed to list heartbeat tasks: ${err.message}`),
      };
    }

    default:
      return { type: 'unknown' };
  }
}
