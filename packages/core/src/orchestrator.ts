import { nanoid } from 'nanoid';
import { TypedEventEmitter } from './events.js';
import { ConversationStore } from './conversation.js';
import type { Message, ToolCall, ToolResult } from './types.js';

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

export class Orchestrator extends TypedEventEmitter {
  private conversations: ConversationStore;
  private cerebrum: CerebrumAdapter | null = null;
  private tools = new Map<string, ToolDefinition>();
  private activeConversationId: string | null = null;

  constructor() {
    super();
    this.conversations = new ConversationStore();
  }

  setCerebrum(cerebrum: CerebrumAdapter): void {
    this.cerebrum = cerebrum;
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
  }

  async stop(): Promise<void> {
    this.removeAllListeners();
  }
}
