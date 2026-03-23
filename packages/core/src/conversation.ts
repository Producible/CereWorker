import { DatabaseSync } from 'node:sqlite';
import { nanoid } from 'nanoid';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Conversation, Message, MessageRole } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('conversation');

const DEFAULT_DB_PATH = join(homedir(), '.cereworker', 'conversations.db');

export class ConversationStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;

    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.ensureSchema();
    log.info('Opened conversation database', { path });
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        toolCalls TEXT,
        toolResult TEXT,
        metadata TEXT,
        FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversationId, timestamp);
    `);
  }

  create(): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: nanoid(),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare('INSERT INTO conversations (id, createdAt, updatedAt) VALUES (?, ?, ?)')
      .run(conversation.id, now, now);
    log.debug('Created conversation', { id: conversation.id });
    return conversation;
  }

  get(id: string): Conversation | undefined {
    const row = this.db
      .prepare('SELECT id, createdAt, updatedAt FROM conversations WHERE id = ?')
      .get(id) as { id: string; createdAt: number; updatedAt: number } | undefined;
    if (!row) return undefined;

    return {
      id: row.id,
      messages: this.getMessages(id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  list(): Conversation[] {
    const rows = this.db
      .prepare('SELECT id, createdAt, updatedAt FROM conversations ORDER BY updatedAt DESC')
      .all() as unknown as Array<{ id: string; createdAt: number; updatedAt: number }>;

    return rows.map((row) => ({
      id: row.id,
      messages: [], // Don't load messages for list view
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  appendMessage(conversationId: string, role: MessageRole, content: string, extra?: Partial<Message>): Message {
    const row = this.db
      .prepare('SELECT id FROM conversations WHERE id = ?')
      .get(conversationId);
    if (!row) throw new Error(`Conversation ${conversationId} not found`);

    const message: Message = {
      id: nanoid(),
      role,
      content,
      timestamp: Date.now(),
      ...extra,
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, conversationId, role, content, timestamp, toolCalls, toolResult, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        conversationId,
        message.role,
        message.content,
        message.timestamp,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolResult ? JSON.stringify(message.toolResult) : null,
        message.metadata ? JSON.stringify(message.metadata) : null,
      );

    this.db
      .prepare('UPDATE conversations SET updatedAt = ? WHERE id = ?')
      .run(Date.now(), conversationId);

    return message;
  }

  getMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, role, content, timestamp, toolCalls, toolResult, metadata
         FROM messages WHERE conversationId = ? ORDER BY timestamp`,
      )
      .all(conversationId) as unknown as Array<{
        id: string;
        role: string;
        content: string;
        timestamp: number;
        toolCalls: string | null;
        toolResult: string | null;
        metadata: string | null;
      }>;

    return rows.map((row) => ({
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      timestamp: row.timestamp,
      ...(row.toolCalls ? { toolCalls: JSON.parse(row.toolCalls) } : {}),
      ...(row.toolResult ? { toolResult: JSON.parse(row.toolResult) } : {}),
      ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
    }));
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(id);
    const deleted = Number(result.changes) > 0;
    log.debug('Deleted conversation', { id, deleted });
    return deleted;
  }

  /** Get the most recent message content from a conversation (for list previews) */
  getPreview(conversationId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT content FROM messages
         WHERE conversationId = ? AND role = 'user'
         ORDER BY timestamp ASC LIMIT 1`,
      )
      .get(conversationId) as { content: string } | undefined;
    return row?.content ?? null;
  }

  close(): void {
    this.db.close();
  }
}
