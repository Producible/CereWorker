import { nanoid } from 'nanoid';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Conversation, Message, MessageRole, TurnJournalEntry } from './types.js';
import { createLogger } from './logger.js';
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  readJsonLines,
  resolveStoreBasePath,
  withTextStoreLock,
  writeJsonFileAtomic,
  writeJsonLines,
} from './text-store.js';
import { markLegacySectionMigrated, readLegacySection } from './legacy-sqlite.js';

const log = createLogger('conversation');

const DEFAULT_DB_PATH = join(homedir(), '.cereworker', 'conversations.db');

interface ConversationMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface TurnJournalRetentionPolicy {
  maxDays: number;
  maxFilesPerConversation: number;
}

interface TurnJournalFileInfo {
  turnId: string;
  path: string;
  mtimeMs: number;
}

export class ConversationStore {
  private readonly inMemory: boolean;
  private readonly baseDir: string | null;
  private readonly conversationsDir: string | null;
  private readonly memoryConversations = new Map<string, Conversation>();

  constructor(dbPath?: string) {
    this.inMemory = dbPath === ':memory:';
    this.baseDir = this.inMemory ? null : resolveStoreBasePath(dbPath ?? DEFAULT_DB_PATH);
    this.conversationsDir = this.baseDir ? join(this.baseDir, 'conversations') : null;
    const legacyDbPath = dbPath ?? DEFAULT_DB_PATH;

    if (this.conversationsDir) {
      ensureDir(this.conversationsDir);
      if (!existsSync(legacyDbPath) || !statSync(legacyDbPath).isDirectory()) {
        this.migrateLegacyDatabase(legacyDbPath);
      }
      log.info('Opened conversation store', { path: this.conversationsDir });
    }
  }

  private migrateLegacyDatabase(dbPath: string): void {
    if (this.inMemory || !this.conversationsDir) return;

    const rows = readLegacySection(
      dbPath,
      'conversations',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db: any) => {
        const conversations = db
          .prepare('SELECT id, createdAt, updatedAt FROM conversations ORDER BY createdAt ASC')
          .all() as Array<ConversationMeta>;
        return conversations.map((conversation) => {
          const messages = db
            .prepare(
              `SELECT id, role, content, timestamp, toolCalls, toolResult, metadata
               FROM messages WHERE conversationId = ? ORDER BY timestamp, rowid`,
            )
            .all(conversation.id) as Array<{
            id: string;
            role: string;
            content: string;
            timestamp: number;
            toolCalls: string | null;
            toolResult: string | null;
            metadata: string | null;
          }>;
          return {
            conversation,
            messages: messages.map((message) => ({
              id: message.id,
              role: message.role as MessageRole,
              content: message.content,
              timestamp: message.timestamp,
              ...(message.toolCalls ? { toolCalls: JSON.parse(message.toolCalls) } : {}),
              ...(message.toolResult ? { toolResult: JSON.parse(message.toolResult) } : {}),
              ...(message.metadata ? { metadata: JSON.parse(message.metadata) } : {}),
            })),
          };
        });
      },
    );

    if (!rows) return;

    for (const row of rows) {
      if (existsSync(this.getConversationDir(row.conversation.id))) continue;
      this.writeConversationMeta(row.conversation.id, row.conversation);
      this.writeConversationMessages(row.conversation.id, row.messages);
    }

    markLegacySectionMigrated(dbPath, 'conversations');
  }

  create(): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: nanoid(),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    if (this.inMemory) {
      this.memoryConversations.set(conversation.id, conversation);
    } else {
      withTextStoreLock(this.conversationsDir!, () => {
        this.writeConversationMeta(conversation.id, conversation);
        this.writeConversationMessages(conversation.id, []);
      });
    }

    log.debug('Created conversation', { id: conversation.id });
    return conversation;
  }

  get(id: string): Conversation | undefined {
    if (this.inMemory) {
      const conversation = this.memoryConversations.get(id);
      return conversation ? { ...conversation, messages: [...conversation.messages] } : undefined;
    }

    const meta = this.readConversationMeta(id);
    if (!meta) return undefined;
    return {
      ...meta,
      messages: this.readConversationMessages(id),
    };
  }

  list(): Conversation[] {
    if (this.inMemory) {
      return Array.from(this.memoryConversations.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((conversation) => ({
          id: conversation.id,
          messages: [],
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        }));
    }

    if (!this.conversationsDir || !existsSync(this.conversationsDir)) return [];
    return readdirSync(this.conversationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readConversationMeta(entry.name))
      .filter((meta): meta is ConversationMeta => meta !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((meta) => ({
        id: meta.id,
        messages: [],
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      }));
  }

  appendMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    extra?: Partial<Message>,
  ): Message {
    const message: Message = {
      id: nanoid(),
      role,
      content,
      timestamp: Date.now(),
      ...extra,
    };

    if (this.inMemory) {
      const conversation = this.memoryConversations.get(conversationId);
      if (!conversation) throw new Error(`Conversation ${conversationId} not found`);
      conversation.messages.push(message);
      conversation.updatedAt = Date.now();
      return message;
    }

    withTextStoreLock(this.getConversationDir(conversationId), () => {
      const meta = this.readConversationMeta(conversationId);
      if (!meta) throw new Error(`Conversation ${conversationId} not found`);

      appendJsonLine(this.getMessagesPath(conversationId), message);
      this.writeConversationMeta(conversationId, {
        ...meta,
        updatedAt: Date.now(),
      });
    });

    return message;
  }

  getMessages(conversationId: string): Message[] {
    if (this.inMemory) {
      return [...(this.memoryConversations.get(conversationId)?.messages ?? [])];
    }
    return this.readConversationMessages(conversationId);
  }

  appendTurnJournalEntry(conversationId: string, turnId: string, entry: TurnJournalEntry): void {
    if (this.inMemory) return;

    withTextStoreLock(this.getConversationDir(conversationId), () => {
      const meta = this.readConversationMeta(conversationId);
      if (!meta) throw new Error(`Conversation ${conversationId} not found`);

      ensureDir(this.getTurnsDir(conversationId));
      appendJsonLine(this.getTurnJournalPath(conversationId, turnId), entry);
    });
  }

  getTurnJournal(conversationId: string, turnId: string): TurnJournalEntry[] {
    if (this.inMemory) return [];
    return readJsonLines<TurnJournalEntry>(this.getTurnJournalPath(conversationId, turnId));
  }

  pruneTurnJournals(
    conversationId: string,
    policy: TurnJournalRetentionPolicy,
  ): { prunedByAge: number; prunedByCount: number; remaining: number } {
    if (this.inMemory) {
      return { prunedByAge: 0, prunedByCount: 0, remaining: 0 };
    }

    return withTextStoreLock(this.getConversationDir(conversationId), () => {
      const meta = this.readConversationMeta(conversationId);
      if (!meta) return { prunedByAge: 0, prunedByCount: 0, remaining: 0 };

      const files = this.listTurnJournalFiles(conversationId);
      if (files.length === 0) {
        return { prunedByAge: 0, prunedByCount: 0, remaining: 0 };
      }

      let retained = [...files];
      let prunedByAge = 0;
      let prunedByCount = 0;

      if (policy.maxDays > 0) {
        const cutoff = Date.now() - policy.maxDays * 24 * 60 * 60 * 1000;
        const expired = retained.filter((file) => file.mtimeMs < cutoff);
        for (const file of expired) {
          rmSync(file.path, { force: true });
        }
        prunedByAge = expired.length;
        retained = retained.filter((file) => file.mtimeMs >= cutoff);
      }

      if (policy.maxFilesPerConversation > 0 && retained.length > policy.maxFilesPerConversation) {
        const sorted = [...retained].sort(
          (a, b) => b.mtimeMs - a.mtimeMs || a.turnId.localeCompare(b.turnId),
        );
        const keep = new Set(
          sorted
            .slice(0, policy.maxFilesPerConversation)
            .map((file) => file.path),
        );
        const overflow = retained.filter((file) => !keep.has(file.path));
        for (const file of overflow) {
          rmSync(file.path, { force: true });
        }
        prunedByCount = overflow.length;
        retained = retained.filter((file) => keep.has(file.path));
      }

      return {
        prunedByAge,
        prunedByCount,
        remaining: retained.length,
      };
    });
  }

  deleteMessages(conversationId: string, messageIds: string[]): number {
    if (messageIds.length === 0) return 0;

    if (this.inMemory) {
      const conversation = this.memoryConversations.get(conversationId);
      if (!conversation) return 0;
      const before = conversation.messages.length;
      conversation.messages = conversation.messages.filter(
        (message) => !messageIds.includes(message.id),
      );
      return before - conversation.messages.length;
    }

    return withTextStoreLock(this.getConversationDir(conversationId), () => {
      const messages = this.readConversationMessages(conversationId);
      if (messages.length === 0) return 0;
      const filtered = messages.filter((message) => !messageIds.includes(message.id));
      const deleted = messages.length - filtered.length;
      if (deleted > 0) {
        this.writeConversationMessages(conversationId, filtered);
      }
      return deleted;
    });
  }

  delete(id: string): boolean {
    if (this.inMemory) {
      const deleted = this.memoryConversations.delete(id);
      log.debug('Deleted conversation', { id, deleted });
      return deleted;
    }

    const conversationDir = this.getConversationDir(id);
    return withTextStoreLock(conversationDir, () => {
      if (!existsSync(conversationDir)) return false;
      rmSync(conversationDir, { recursive: true, force: true });
      log.debug('Deleted conversation', { id, deleted: true });
      return true;
    });
  }

  getPreview(conversationId: string): string | null {
    const messages = this.getMessages(conversationId);
    return messages.find((message) => message.role === 'user')?.content ?? null;
  }

  close(): void {
    // No-op for file-backed stores.
  }

  private getConversationDir(id: string): string {
    return join(this.conversationsDir ?? dirname(DEFAULT_DB_PATH), id);
  }

  private getMetaPath(id: string): string {
    return join(this.getConversationDir(id), 'meta.json');
  }

  private getMessagesPath(id: string): string {
    return join(this.getConversationDir(id), 'messages.jsonl');
  }

  private getTurnsDir(id: string): string {
    return join(this.getConversationDir(id), 'turns');
  }

  private getTurnJournalPath(id: string, turnId: string): string {
    return join(this.getTurnsDir(id), `${turnId}.jsonl`);
  }

  private listTurnJournalFiles(id: string): TurnJournalFileInfo[] {
    const turnsDir = this.getTurnsDir(id);
    if (!existsSync(turnsDir)) return [];
    return readdirSync(turnsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => {
        const path = join(turnsDir, entry.name);
        return {
          turnId: entry.name.slice(0, -'.jsonl'.length),
          path,
          mtimeMs: statSync(path).mtimeMs,
        };
      });
  }

  private readConversationMeta(id: string): ConversationMeta | undefined {
    return readJsonFile<ConversationMeta | null>(this.getMetaPath(id), null) ?? undefined;
  }

  private writeConversationMeta(id: string, meta: ConversationMeta): void {
    ensureDir(this.getConversationDir(id));
    writeJsonFileAtomic(this.getMetaPath(id), meta);
  }

  private readConversationMessages(id: string): Message[] {
    return readJsonLines<Message>(this.getMessagesPath(id));
  }

  private writeConversationMessages(id: string, messages: Message[]): void {
    ensureDir(this.getConversationDir(id));
    writeJsonLines(this.getMessagesPath(id), messages);
  }
}
