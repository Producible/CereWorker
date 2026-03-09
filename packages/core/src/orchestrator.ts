import { nanoid } from 'nanoid';
import { TypedEventEmitter } from './events.js';
import { ConversationStore } from './conversation.js';
import { SubAgentManager } from './sub-agent-manager.js';
import { createSubAgentTools } from './sub-agent-tools.js';
import type { Message, ToolCall, ToolResult, VerificationResult, AgentHealthAction } from './types.js';

export interface CerebrumAdapter {
  stream(
    messages: Message[],
    tools: Record<string, ToolDefinition>,
    callbacks: StreamCallbacks,
  ): Promise<void>;
}

export interface ToolDefinition {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onToolCall: (toolCall: ToolCall) => Promise<ToolResult>;
  onFinish: (content: string) => void;
  onError: (error: Error) => void;
}

export interface CerebellumAdapter {
  isConnected(): boolean;
  verifyToolResult(
    toolName: string,
    toolArgs: Record<string, string>,
    toolOutput: string,
    claimedSuccess: boolean,
  ): Promise<{
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; description: string }>;
    modelVerdict: boolean;
  } | null>;
  reportAgentStates?(
    agents: Array<{
      id: string;
      task: string;
      status: string;
      spawnedAt: number;
      lastActivityAt: number;
      timeoutMs: number;
      messagesCount: number;
      toolCallsCount: number;
      retryCount: number;
    }>,
  ): Promise<AgentHealthAction[]>;
}

export class Orchestrator extends TypedEventEmitter {
  private conversations: ConversationStore;
  private cerebrum: CerebrumAdapter | null = null;
  private cerebellum: CerebellumAdapter | null = null;
  private subAgentManager: SubAgentManager | null = null;
  private tools = new Map<string, ToolDefinition>();
  private activeConversationId: string | null = null;
  private verificationEnabled = true;
  private verificationTimeoutMs = 5000;
  private monitorIntervalMs = 30_000;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.conversations = new ConversationStore();
  }

  setCerebrum(cerebrum: CerebrumAdapter): void {
    this.cerebrum = cerebrum;
  }

  setCerebellum(
    cerebellum: CerebellumAdapter,
    options?: { enabled?: boolean; timeoutMs?: number },
  ): void {
    this.cerebellum = cerebellum;
    if (options?.enabled !== undefined) this.verificationEnabled = options.enabled;
    if (options?.timeoutMs !== undefined) this.verificationTimeoutMs = options.timeoutMs;
  }

  setupSubAgents(options?: {
    maxConcurrent?: number;
    baseDir?: string;
    monitorIntervalMs?: number;
  }): SubAgentManager | null {
    if (!this.cerebrum) return null;

    if (options?.monitorIntervalMs) this.monitorIntervalMs = options.monitorIntervalMs;

    this.subAgentManager = new SubAgentManager({
      cerebrum: this.cerebrum,
      tools: this.tools,
      maxConcurrent: options?.maxConcurrent,
      baseDir: options?.baseDir,
    });

    // Register sub-agent tools with the orchestrator
    const agentTools = createSubAgentTools(this.subAgentManager);
    for (const [name, tool] of Object.entries(agentTools)) {
      this.tools.set(name, tool);
    }

    return this.subAgentManager;
  }

  getSubAgentManager(): SubAgentManager | null {
    return this.subAgentManager;
  }

  registerTool(name: string, tool: ToolDefinition): void {
    this.tools.set(name, tool);
  }

  getActiveConversationId(): string | null {
    return this.activeConversationId;
  }

  getConversation(id: string) {
    return this.conversations.get(id);
  }

  getMessages(conversationId?: string): Message[] {
    const id = conversationId ?? this.activeConversationId;
    if (!id) return [];
    return this.conversations.getMessages(id);
  }

  startConversation(): string {
    const conversation = this.conversations.create();
    this.activeConversationId = conversation.id;
    return conversation.id;
  }

  async sendMessage(content: string, conversationId?: string): Promise<void> {
    if (!this.cerebrum) throw new Error('Cerebrum not connected');

    const convId = conversationId ?? this.activeConversationId;
    if (!convId) throw new Error('No active conversation');

    const userMessage = this.conversations.appendMessage(convId, 'user', content);
    this.emit({ type: 'message:user', message: userMessage });
    this.emit({ type: 'message:cerebrum:start', conversationId: convId });

    const messages = this.conversations.getMessages(convId);
    const toolDefs = Object.fromEntries(this.tools);
    let fullContent = '';

    try {
      await this.cerebrum.stream(messages, toolDefs, {
        onChunk: (chunk) => {
          fullContent += chunk;
          this.emit({ type: 'message:cerebrum:chunk', chunk });
        },
        onToolCall: async (toolCall) => {
          this.emit({ type: 'message:cerebrum:toolcall', toolCall });
          this.emit({ type: 'tool:start', callId: toolCall.id, name: toolCall.name });

          const tool = this.tools.get(toolCall.name);
          let result: ToolResult;

          if (tool) {
            try {
              const output = await tool.execute(toolCall.args);
              result = { callId: toolCall.id, output, isError: false };
            } catch (err) {
              result = {
                callId: toolCall.id,
                output: err instanceof Error ? err.message : String(err),
                isError: true,
              };
            }
          } else {
            result = { callId: toolCall.id, output: `Unknown tool: ${toolCall.name}`, isError: true };
          }

          this.emit({ type: 'tool:end', result });

          // Cerebellum verification (non-blocking)
          if (this.cerebellum?.isConnected() && this.verificationEnabled) {
            try {
              this.emit({ type: 'verification:start', callId: toolCall.id, toolName: toolCall.name });

              const toolArgs: Record<string, string> = {};
              for (const [k, v] of Object.entries(toolCall.args)) {
                toolArgs[k] = String(v);
              }

              const verifyPromise = this.cerebellum.verifyToolResult(
                toolCall.name,
                toolArgs,
                result.output,
                !result.isError,
              );

              const timeoutPromise = new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), this.verificationTimeoutMs),
              );

              const verification = await Promise.race([verifyPromise, timeoutPromise]);

              if (verification && !verification.passed) {
                const failedChecks = verification.checks
                  .filter((c) => !c.passed)
                  .map((c) => c.description)
                  .join(', ');
                result.output += `\n[Cerebellum warning: ${failedChecks}]`;
              }

              if (verification) {
                const vResult: VerificationResult = {
                  passed: verification.passed,
                  checks: verification.checks,
                  modelVerdict: verification.modelVerdict,
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                };
                this.emit({ type: 'verification:end', result: vResult });
              }
            } catch {
              // Verification failure should never block tool execution
            }
          }

          this.conversations.appendMessage(convId, 'tool', result.output, {
            toolResult: result,
          });

          return result;
        },
        onFinish: (content) => {
          const cerebrumMessage = this.conversations.appendMessage(convId, 'cerebrum', content);
          this.emit({ type: 'message:cerebrum:end', message: cerebrumMessage });
        },
        onError: (error) => {
          this.emit({ type: 'error', error });
        },
      });
    } catch (error) {
      this.emit({
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async start(): Promise<void> {
    if (!this.activeConversationId) {
      this.startConversation();
    }

    // Start sub-agent monitoring loop if cerebellum + sub-agents are enabled
    if (this.subAgentManager && this.cerebellum?.reportAgentStates) {
      this.startMonitorLoop();
    }
  }

  async stop(): Promise<void> {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.removeAllListeners();
  }

  private startMonitorLoop(): void {
    if (this.monitorTimer) return;

    this.monitorTimer = setInterval(async () => {
      if (!this.subAgentManager || !this.cerebellum?.reportAgentStates) return;

      const agents = this.subAgentManager.listAgents();
      const activeAgents = agents.filter((a) => a.status === 'running' || a.status === 'pending');
      if (activeAgents.length === 0) return;

      try {
        const actions = await this.cerebellum.reportAgentStates(
          activeAgents.map((a) => ({
            id: a.id,
            task: a.task,
            status: a.status,
            spawnedAt: a.spawnedAt,
            lastActivityAt: a.lastActivityAt,
            timeoutMs: a.timeoutMs,
            messagesCount: a.messagesCount,
            toolCallsCount: a.toolCallsCount,
            retryCount: a.retryCount,
          })),
        );

        const actionable = actions.filter((a) => a.action !== 'ok');
        if (actionable.length > 0) {
          this.emit({ type: 'agent:health', actions: actionable });
        }

        for (const action of actions) {
          switch (action.action) {
            case 'ping':
              this.subAgentManager.ping(action.agentId);
              break;
            case 'retry':
              await this.subAgentManager.retry(action.agentId);
              break;
            case 'cancel':
            case 'timeout':
              this.subAgentManager.cancel(action.agentId);
              break;
          }
        }
      } catch {
        // Monitor failure is non-blocking
      }

      // Prune old completed agents
      this.subAgentManager.prune();
    }, this.monitorIntervalMs);
  }
}
