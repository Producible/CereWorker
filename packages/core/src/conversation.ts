import { nanoid } from 'nanoid';
import type { Conversation, Message, MessageRole } from './types.js';

export class ConversationStore {
  private conversations = new Map<string, Conversation>();

  create(): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: nanoid(),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  list(): Conversation[] {
    return Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  appendMessage(conversationId: string, role: MessageRole, content: string, extra?: Partial<Message>): Message {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} not found`);

    const message: Message = {
      id: nanoid(),
      role,
      content,
      timestamp: Date.now(),
      ...extra,
    };

    conversation.messages.push(message);
    conversation.updatedAt = Date.now();
    return message;
  }

  getMessages(conversationId: string): Message[] {
    return this.conversations.get(conversationId)?.messages ?? [];
  }

  delete(id: string): boolean {
    return this.conversations.delete(id);
  }
}
