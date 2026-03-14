import { nanoid } from 'nanoid';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { Conversation, Message, MessageRole } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('conversation');

const require = createRequire(import.meta.url);

// better-sqlite3 is a native module — use require for compatibility
interface SqliteDb {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): SqliteStatement;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function tryOpenDb(dbPath: string): SqliteDb | null {
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath) as SqliteDb;
  } catch {
    return null;
  }
}

const DEFAULT_DB_PATH = join(homedir(), '.cereworker', 'conversations.db');

/** Storage backend interface used by ConversationStore */
interface StorageBackend {
  createConversation(id: string, now: number): void;
  getConversation(id: string): { id: string; createdAt: number; updatedAt: number } | undefined;
  listConversations(): Array<{ id: string; createdAt: number; updatedAt: number }>;
  insertMessage(conversationId: string, message: Message): void;
  getMessages(conversationId: string): Message[];
  deleteConversation(id: string): boolean;
  getPreview(conversationId: string): string | null;
  close(): void;
}

/** SQLite-backed storage using better-sqlite3 */
class SqliteBackend implements StorageBackend {
  private db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.ensureSchema();
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

  createConversation(id: string, now: number): void {
    this.db
      .prepare('INSERT INTO conversations (id, createdAt, updatedAt) VALUES (?, ?, ?)')
      .run(id, now, now);
  }

  getConversation(id: string) {
    return this.db
      .prepare('SELECT id, createdAt, updatedAt FROM conversations WHERE id = ?')
      .get(id) as { id: string; createdAt: number; updatedAt: number } | undefined;
  }

  listConversations() {
    return this.db
      .prepare('SELECT id, createdAt, updatedAt FROM conversations ORDER BY updatedAt DESC')
      .all() as Array<{ id: string; createdAt: number; updatedAt: number }>;
  }

  insertMessage(conversationId: string, message: Message): void {
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
  }

  getMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, role, content, timestamp, toolCalls, toolResult, metadata
         FROM messages WHERE conversationId = ? ORDER BY timestamp`,
      )
      .all(conversationId) as Array<{
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

  deleteConversation(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

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

/** JSON file fallback when better-sqlite3 is not available */
interface JsonStoreData {
  conversations: Record<string, { id: string; createdAt: number; updatedAt: number }>;
  messages: Record<string, Message[]>;
}

class JsonFileBackend implements StorageBackend {
  private data: JsonStoreData;
  private filePath: string | null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string | null) {
    this.filePath = filePath;
    this.data = { conversations: {}, messages: {} };

    if (filePath && existsSync(filePath)) {
      try {
        this.data = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        log.warn('Failed to parse conversation JSON, starting fresh');
      }
    }
  }

  createConversation(id: string, now: number): void {
    this.data.conversations[id] = { id, createdAt: now, updatedAt: now };
    this.data.messages[id] = [];
    this.scheduleFlush();
  }

  getConversation(id: string) {
    return this.data.conversations[id];
  }

  listConversations() {
    return Object.values(this.data.conversations).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  insertMessage(conversationId: string, message: Message): void {
    const msgs = this.data.messages[conversationId];
    if (msgs) {
      msgs.push(message);
      const conv = this.data.conversations[conversationId];
      if (conv) conv.updatedAt = Date.now();
      this.scheduleFlush();
    }
  }

  getMessages(conversationId: string): Message[] {
    return [...(this.data.messages[conversationId] ?? [])];
  }

  deleteConversation(id: string): boolean {
    const existed = id in this.data.conversations;
    delete this.data.conversations[id];
    delete this.data.messages[id];
    if (existed) this.scheduleFlush();
    return existed;
  }

  getPreview(conversationId: string): string | null {
    const msgs = this.data.messages[conversationId] ?? [];
    const first = msgs.find((m) => m.role === 'user');
    return first?.content ?? null;
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Debounced write — flush at most once per 500ms to avoid excessive I/O */
  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 500);
  }

  private flush(): void {
    if (!this.dirty || !this.filePath) return;
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8');
      this.dirty = false;
    } catch (err) {
      log.warn('Failed to write conversation JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export class ConversationStore {
  private backend: StorageBackend;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;

    // Try SQLite first
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    const jsonPath = path === ':memory:' ? null : path.replace(/\.db$/, '.json');
    const db = tryOpenDb(path);
    if (db) {
      const sqlite = new SqliteBackend(db);
      this.backend = sqlite;
      log.info('Opened conversation database', { path });

      // Migrate JSON → SQLite if a JSON file exists from a previous fallback
      if (jsonPath && existsSync(jsonPath)) {
        this.migrateJsonToSqlite(jsonPath, sqlite);
      }
    } else {
      this.backend = new JsonFileBackend(jsonPath);
      if (jsonPath) {
        const hint =
          process.platform === 'darwin'
            ? 'xcode-select --install'
            : process.platform === 'win32'
              ? 'npm install --global windows-build-tools'
              : 'sudo apt install build-essential';
        log.info(`better-sqlite3 not available, using JSON file store. For better performance, install build tools and reinstall:\n  ${hint} && npm install -g @cereworker/cli`, { path: jsonPath });
      }
    }
  }

  create(): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: nanoid(),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    this.backend.createConversation(conversation.id, now);
    log.debug('Created conversation', { id: conversation.id });
    return conversation;
  }

  get(id: string): Conversation | undefined {
    const row = this.backend.getConversation(id);
    if (!row) return undefined;

    return {
      id: row.id,
      messages: this.getMessages(id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  list(): Conversation[] {
    return this.backend.listConversations().map((row) => ({
      id: row.id,
      messages: [], // Don't load messages for list view
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  appendMessage(conversationId: string, role: MessageRole, content: string, extra?: Partial<Message>): Message {
    const row = this.backend.getConversation(conversationId);
    if (!row) throw new Error(`Conversation ${conversationId} not found`);

    const message: Message = {
      id: nanoid(),
      role,
      content,
      timestamp: Date.now(),
      ...extra,
    };

    this.backend.insertMessage(conversationId, message);
    return message;
  }

  getMessages(conversationId: string): Message[] {
    return this.backend.getMessages(conversationId);
  }

  delete(id: string): boolean {
    const result = this.backend.deleteConversation(id);
    log.debug('Deleted conversation', { id, deleted: result });
    return result;
  }

  /** Get the most recent message content from a conversation (for list previews) */
  getPreview(conversationId: string): string | null {
    return this.backend.getPreview(conversationId);
  }

  close(): void {
    this.backend.close();
  }

  /** Migrate conversations from a JSON fallback file into SQLite, then rename the JSON file */
  private migrateJsonToSqlite(jsonPath: string, sqlite: SqliteBackend): void {
    try {
      const raw: JsonStoreData = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      let migrated = 0;

      for (const conv of Object.values(raw.conversations)) {
        // Skip if already exists in SQLite (e.g. partial previous migration)
        if (sqlite.getConversation(conv.id)) continue;

        sqlite.createConversation(conv.id, conv.createdAt);
        const msgs = raw.messages[conv.id] ?? [];
        for (const msg of msgs) {
          sqlite.insertMessage(conv.id, msg);
        }
        migrated++;
      }

      // Rename instead of delete so nothing is lost if something goes wrong
      renameSync(jsonPath, jsonPath + '.migrated');
      log.info('Migrated JSON conversations to SQLite', { migrated, source: jsonPath });
    } catch (err) {
      log.warn('Failed to migrate JSON conversations to SQLite', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
