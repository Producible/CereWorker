import { nanoid } from 'nanoid';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConversationStore } from './conversation.js';
import { ToolRuntime } from './tool-runtime.js';
import type {
  Message,
  SubAgentState,
  SubAgentStatus,
  SubAgentCleanup,
  SubAgentSummary,
} from './types.js';
import type { CerebrumAdapter, ToolDefinition, StreamCallbacks } from './orchestrator.js';

interface SubAgentInstance {
  id: string;
  sessionKey: string;
  parentSessionKey: string;
  task: string;
  label?: string;
  status: SubAgentStatus;
  cleanup: SubAgentCleanup;
  spawnedAt: number;
  lastActivityAt: number;
  timeoutMs: number;
  retryCount: number;
  conversation: ConversationStore;
  conversationId: string;
  agentDir: string;
  abortController: AbortController;
  result?: string;
  error?: string;
  messagesCount: number;
  toolCallsCount: number;
}

export interface SubAgentManagerOptions {
  cerebrum: CerebrumAdapter;
  tools: Map<string, ToolDefinition>;
  maxConcurrent?: number;
  baseDir?: string;
  toolRuntime?: ToolRuntime;
}

export class SubAgentManager {
  private agents = new Map<string, SubAgentInstance>();
  private cerebrum: CerebrumAdapter;
  private tools: Map<string, ToolDefinition>;
  private maxConcurrent: number;
  private baseDir: string;
  private toolRuntime: ToolRuntime;

  constructor(opts: SubAgentManagerOptions) {
    this.cerebrum = opts.cerebrum;
    this.tools = opts.tools;
    this.maxConcurrent = opts.maxConcurrent ?? 5;
    this.baseDir = opts.baseDir ?? join(homedir(), '.cereworker', 'agents');
    this.toolRuntime = opts.toolRuntime ?? new ToolRuntime();
    this.ensureDir(this.baseDir);
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  async spawn(
    task: string,
    opts?: {
      timeoutMs?: number;
      label?: string;
      cleanup?: SubAgentCleanup;
      parentSessionKey?: string;
    },
  ): Promise<string> {
    const running = this.listAgents().filter((a) => a.status === 'running' || a.status === 'pending');
    if (running.length >= this.maxConcurrent) {
      throw new Error(`Max concurrent sub-agents (${this.maxConcurrent}) reached`);
    }

    const id = nanoid(10);
    const sessionKey = `agent:main:subagent:${id}`;
    const agentDir = join(this.baseDir, id);
    const memoryDir = join(agentDir, 'memory');

    this.ensureDir(agentDir);
    this.ensureDir(memoryDir);

    // Initialize empty MEMORY.md for the agent
    writeFileSync(join(memoryDir, 'MEMORY.md'), '', 'utf-8');

    const conversation = new ConversationStore(join(agentDir, 'conversations.db'));
    const conv = conversation.create();

    const instance: SubAgentInstance = {
      id,
      sessionKey,
      parentSessionKey: opts?.parentSessionKey ?? 'agent:main',
      task,
      label: opts?.label,
      status: 'pending',
      cleanup: opts?.cleanup ?? 'delete',
      spawnedAt: Date.now(),
      lastActivityAt: Date.now(),
      timeoutMs: opts?.timeoutMs ?? 5 * 60_000,
      retryCount: 0,
      conversation,
      conversationId: conv.id,
      agentDir,
      abortController: new AbortController(),
      messagesCount: 0,
      toolCallsCount: 0,
    };

    this.agents.set(id, instance);
    this.saveSessionMeta(instance);

    // Run agent asynchronously (fire and forget, errors are captured)
    this.runAgent(instance).catch(() => {
      // Errors are already handled inside runAgent
    });

    return id;
  }

  getAgent(id: string): SubAgentState | null {
    const instance = this.agents.get(id);
    if (!instance) return null;
    return this.toState(instance);
  }

  listAgents(): SubAgentState[] {
    return Array.from(this.agents.values()).map((i) => this.toState(i));
  }

  getSummary(): SubAgentSummary {
    const agents = this.listAgents();
    return {
      total: agents.length,
      running: agents.filter((a) => a.status === 'running' || a.status === 'pending').length,
      completed: agents.filter((a) => a.status === 'completed').length,
      failed: agents.filter((a) => a.status === 'failed' || a.status === 'timeout' || a.status === 'cancelled').length,
    };
  }

  cancel(id: string): void {
    const instance = this.agents.get(id);
    if (!instance) return;
    if (instance.status !== 'running' && instance.status !== 'pending') return;

    instance.abortController.abort();
    instance.status = 'cancelled';
    this.saveSessionMeta(instance);
  }

  async retry(id: string): Promise<string> {
    const instance = this.agents.get(id);
    if (!instance) throw new Error(`Agent ${id} not found`);
    if (instance.status === 'running' || instance.status === 'pending') {
      throw new Error(`Agent ${id} is still running`);
    }

    // Re-spawn with same task in the same directory
    instance.status = 'pending';
    instance.retryCount++;
    instance.lastActivityAt = Date.now();
    instance.abortController = new AbortController();
    instance.result = undefined;
    instance.error = undefined;

    // Create a new conversation for the retry
    const conv = instance.conversation.create();
    instance.conversationId = conv.id;
    instance.messagesCount = 0;
    instance.toolCallsCount = 0;

    this.saveSessionMeta(instance);

    this.runAgent(instance).catch(() => {});

    return id;
  }

  ping(id: string): void {
    const instance = this.agents.get(id);
    if (!instance || instance.status !== 'running') return;

    instance.conversation.appendMessage(
      instance.conversationId,
      'system',
      'You appear to be stalled. Please continue working on your task or report your findings.',
    );
    instance.lastActivityAt = Date.now();
    instance.messagesCount++;
  }

  prune(maxAgeMs: number = 30 * 60_000): void {
    const now = Date.now();
    for (const [id, instance] of this.agents) {
      if (instance.status === 'running' || instance.status === 'pending') continue;
      if (now - instance.lastActivityAt < maxAgeMs) continue;

      if (instance.cleanup === 'delete') {
        try {
          rmSync(instance.agentDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
      this.agents.delete(id);
    }
  }

  readTranscript(id: string): Message[] | null {
    const instance = this.agents.get(id);
    if (!instance) return null;
    return instance.conversation.getMessages(instance.conversationId);
  }

  private async runAgent(instance: SubAgentInstance): Promise<void> {
    instance.status = 'running';
    this.saveSessionMeta(instance);

    // Set up timeout
    const timeoutId = setTimeout(() => {
      instance.abortController.abort();
    }, instance.timeoutMs);

    try {
      const agentTools = this.createAgentTools(instance.agentDir);

      // Send the task as the first message
      const toolNames = Array.from(agentTools.keys()).join(', ');
      const timeoutMin = Math.round(instance.timeoutMs / 60000);
      const systemMsg =
        `You are a sub-agent with a focused task. You have ${timeoutMin} minutes.\n` +
        `Available tools: ${toolNames}\n` +
        `Work autonomously — do not ask questions. Use memory_write to save findings.\n` +
        `When done, clearly state: what you found, what you did, and whether it succeeded.`;
      instance.conversation.appendMessage(
        instance.conversationId,
        'system',
        systemMsg,
      );
      instance.conversation.appendMessage(instance.conversationId, 'user', instance.task);
      instance.messagesCount += 2;
      this.appendTranscript(instance, { role: 'system', content: systemMsg });
      this.appendTranscript(instance, { role: 'user', content: instance.task });

      // Stream the cerebrum response
      const messages = instance.conversation.getMessages(instance.conversationId);
      const toolDefs = Object.fromEntries(agentTools);
      let fullContent = '';

      await new Promise<void>((resolve, reject) => {
        if (instance.abortController.signal.aborted) {
          reject(new Error('Agent aborted'));
          return;
        }

        const abortHandler = () => reject(new Error('Agent aborted'));
        instance.abortController.signal.addEventListener('abort', abortHandler, { once: true });

        this.cerebrum
          .stream(messages, toolDefs, {
            onChunk: (chunk) => {
              fullContent += chunk;
              instance.lastActivityAt = Date.now();
            },
            onToolCall: async (toolCall) => {
              instance.lastActivityAt = Date.now();
              instance.toolCallsCount++;
              const requestedToolName = toolCall.name;
              const { toolName, result } = await this.toolRuntime.execute({
                toolCall,
                tools: agentTools,
                conversationId: instance.conversationId,
                sessionKey: instance.sessionKey,
                scopeKey: instance.sessionKey,
              });

              instance.conversation.appendMessage(instance.conversationId, 'tool', result.output, {
                toolResult: result,
                metadata: {
                  toolName,
                  ...(requestedToolName !== toolName ? { requestedToolName } : {}),
                },
              });
              instance.messagesCount++;
              this.appendTranscript(instance, { role: 'tool', content: result.output, toolName });
              return result;
            },
            onFinish: (content, toolCalls) => {
              instance.conversation.appendMessage(
                instance.conversationId, 'cerebrum', content,
                toolCalls?.length ? { toolCalls } : undefined,
              );
              instance.messagesCount++;
              instance.result = content;
              this.appendTranscript(instance, { role: 'cerebrum', content });

              instance.abortController.signal.removeEventListener('abort', abortHandler);
              resolve();
            },
            onError: (error) => {
              instance.abortController.signal.removeEventListener('abort', abortHandler);
              reject(error);
            },
          })
          .catch(reject);
      });

      instance.status = 'completed';
    } catch (err) {
      if (instance.abortController.signal.aborted) {
        // Check if it was a timeout or manual cancel (status may have been
        // set to 'cancelled' externally by cancel())
        if ((instance.status as string) !== 'cancelled') {
          instance.status = 'timeout';
        }
      } else {
        instance.status = 'failed';
        instance.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timeoutId);
      this.saveSessionMeta(instance);
    }
  }

  private createAgentTools(agentDir: string): Map<string, ToolDefinition> {
    const agentTools = new Map<string, ToolDefinition>();
    const memoryDir = join(agentDir, 'memory');

    // Copy shared tools (shell, file ops, etc.) but NOT sub-agent tools (no recursion)
    for (const [name, tool] of this.tools) {
      if (name === 'spawn_agent' || name === 'query_agents' || name === 'cancel_agent') {
        continue;
      }
      // Replace memory tools with agent-scoped versions
      if (name.startsWith('memory_')) {
        continue;
      }
      agentTools.set(name, tool);
    }

    // Agent-scoped memory tools
    agentTools.set('memory_read', {
      description: 'Read your memory file (MEMORY.md or a daily log)',
      parameters: {
        file: { type: 'string', description: 'Optional memory file name (defaults to MEMORY.md)', required: false },
      },
      execute: async (args) => {
        const file = (args as { file?: string }).file ?? 'MEMORY.md';
        const safeName = file.replace(/[/\\]/g, '');
        const path = join(memoryDir, safeName);
        if (!existsSync(path)) return `File "${file}" not found.`;
        return readFileSync(path, 'utf-8') || '(empty file)';
      },
    });

    agentTools.set('memory_write', {
      description: 'Write/update your MEMORY.md file',
      parameters: {
        content: { type: 'string', description: 'The full content to write to MEMORY.md', required: true },
      },
      execute: async (args) => {
        const content = (args as { content: string }).content;
        writeFileSync(join(memoryDir, 'MEMORY.md'), content, 'utf-8');
        return 'MEMORY.md updated successfully.';
      },
    });

    agentTools.set('memory_log', {
      description: "Append a note to today's daily log",
      parameters: {
        content: { type: 'string', description: 'The note content to append to today\'s log', required: true },
      },
      execute: async (args) => {
        const content = (args as { content: string }).content;
        const today = new Date().toISOString().slice(0, 10);
        const entry = `\n---\n_${new Date().toISOString()}_\n\n${content}\n`;
        appendFileSync(join(memoryDir, `${today}.md`), entry, 'utf-8');
        return `Logged to ${today}.md`;
      },
    });

    agentTools.set('memory_search', {
      description: 'Search across your memory files',
      parameters: {
        query: { type: 'string', description: 'The text to search for across memory files', required: true },
      },
      execute: async (args) => {
        const query = (args as { query: string }).query.toLowerCase();
        const files = existsSync(memoryDir)
          ? readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
          : [];
        const results: string[] = [];

        for (const file of files) {
          const content = readFileSync(join(memoryDir, file), 'utf-8');
          if (content.toLowerCase().includes(query)) {
            const lines = content
              .split('\n')
              .filter((l) => l.toLowerCase().includes(query))
              .slice(0, 5);
            results.push(`## ${file}\n${lines.join('\n')}`);
          }
        }

        return results.length > 0 ? results.join('\n\n') : `No matches found for "${query}"`;
      },
    });

    return agentTools;
  }

  private saveSessionMeta(instance: SubAgentInstance): void {
    const meta = {
      id: instance.id,
      sessionKey: instance.sessionKey,
      parentSessionKey: instance.parentSessionKey,
      task: instance.task,
      label: instance.label,
      status: instance.status,
      cleanup: instance.cleanup,
      spawnedAt: instance.spawnedAt,
      lastActivityAt: instance.lastActivityAt,
      timeoutMs: instance.timeoutMs,
      result: instance.result,
      error: instance.error,
      messagesCount: instance.messagesCount,
      toolCallsCount: instance.toolCallsCount,
      retryCount: instance.retryCount,
    };

    try {
      writeFileSync(join(instance.agentDir, 'session.json'), JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // Ignore write errors
    }
  }

  private appendTranscript(
    instance: SubAgentInstance,
    entry: { role: string; content: string; toolName?: string },
  ): void {
    const line = JSON.stringify({
      ...entry,
      timestamp: Date.now(),
    });

    try {
      appendFileSync(join(instance.agentDir, 'transcript.jsonl'), line + '\n', 'utf-8');
    } catch {
      // Ignore write errors
    }
  }

  private toState(instance: SubAgentInstance): SubAgentState {
    return {
      id: instance.id,
      sessionKey: instance.sessionKey,
      parentSessionKey: instance.parentSessionKey,
      task: instance.task,
      label: instance.label,
      status: instance.status,
      cleanup: instance.cleanup,
      spawnedAt: instance.spawnedAt,
      lastActivityAt: instance.lastActivityAt,
      timeoutMs: instance.timeoutMs,
      result: instance.result,
      error: instance.error,
      messagesCount: instance.messagesCount,
      toolCallsCount: instance.toolCallsCount,
      retryCount: instance.retryCount,
      memoryDir: join(instance.agentDir, 'memory'),
    };
  }
}
