import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from './conversation.js';

const require = createRequire(import.meta.url);

describe('ConversationStore', () => {
  let store: ConversationStore;

  beforeEach(() => {
    store = new ConversationStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates a conversation with an id and timestamps', () => {
    const conv = store.create();
    expect(conv.id).toBeTruthy();
    expect(conv.createdAt).toBeGreaterThan(0);
    expect(conv.updatedAt).toBe(conv.createdAt);
    expect(conv.messages).toEqual([]);
  });

  it('retrieves a conversation by id', () => {
    const created = store.create();
    const fetched = store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it('returns undefined for unknown id', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('appends messages and retrieves them in order', () => {
    const conv = store.create();
    store.appendMessage(conv.id, 'user', 'hello');
    store.appendMessage(conv.id, 'cerebrum', 'hi back');
    store.appendMessage(conv.id, 'user', 'second question');

    const msgs = store.getMessages(conv.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('hello');
    expect(msgs[1].role).toBe('cerebrum');
    expect(msgs[1].content).toBe('hi back');
    expect(msgs[2].content).toBe('second question');
  });

  it('appends message with toolResult metadata', () => {
    const conv = store.create();
    store.appendMessage(conv.id, 'tool', 'file contents', {
      toolResult: { callId: 'tc1', output: 'file contents', isError: false },
      metadata: { toolName: 'readFile' },
    });

    const msgs = store.getMessages(conv.id);
    expect(msgs[0].toolResult).toEqual({ callId: 'tc1', output: 'file contents', isError: false });
    expect(msgs[0].metadata).toEqual({ toolName: 'readFile' });
  });

  it('throws when appending to nonexistent conversation', () => {
    expect(() => store.appendMessage('bad-id', 'user', 'test')).toThrow('not found');
  });

  it('lists conversations and returns all of them', () => {
    const c1 = store.create();
    const c2 = store.create();
    const c3 = store.create();

    const list = store.list();
    expect(list.length).toBe(3);
    const ids = list.map((c) => c.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
    expect(ids).toContain(c3.id);
  });

  it('list returns empty messages array (lazy loading)', () => {
    const conv = store.create();
    store.appendMessage(conv.id, 'user', 'hello');
    const list = store.list();
    expect(list[0].messages).toEqual([]);
  });

  it('deletes a conversation and its messages', () => {
    const conv = store.create();
    store.appendMessage(conv.id, 'user', 'hello');
    expect(store.delete(conv.id)).toBe(true);
    expect(store.get(conv.id)).toBeUndefined();
    expect(store.getMessages(conv.id)).toEqual([]);
  });

  it('delete returns false for nonexistent conversation', () => {
    expect(store.delete('nope')).toBe(false);
  });

  it('getPreview returns first user message content', () => {
    const conv = store.create();
    store.appendMessage(conv.id, 'user', 'What is the weather?');
    store.appendMessage(conv.id, 'cerebrum', 'It is sunny.');

    expect(store.getPreview(conv.id)).toBe('What is the weather?');
  });

  it('getPreview returns null for conversation with no user messages', () => {
    const conv = store.create();
    store.appendMessage(conv.id, 'system', 'You are a helpful assistant');
    expect(store.getPreview(conv.id)).toBeNull();
  });

  it('updates updatedAt when appending a message', () => {
    const conv = store.create();
    const originalUpdatedAt = conv.updatedAt;

    // Small delay to ensure timestamp differs
    store.appendMessage(conv.id, 'user', 'hello');
    const updated = store.get(conv.id);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it('migrates legacy SQLite conversation data into text files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conversation-migration-'));
    const dbPath = join(dir, 'conversations.db');
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE conversations (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          toolCalls TEXT,
          toolResult TEXT,
          metadata TEXT
        );
      `);
      db.prepare('INSERT INTO conversations (id, createdAt, updatedAt) VALUES (?, ?, ?)').run(
        'conv-1',
        1,
        2,
      );
      db.prepare(
        `INSERT INTO messages (id, conversationId, role, content, timestamp, toolCalls, toolResult, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('msg-1', 'conv-1', 'user', 'hello', 10, null, null, null);
      db.prepare(
        `INSERT INTO messages (id, conversationId, role, content, timestamp, toolCalls, toolResult, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('msg-2', 'conv-1', 'cerebrum', 'world', 11, null, null, null);
      db.close();

      const migrated = new ConversationStore(dbPath);
      const conversation = migrated.get('conv-1');
      expect(conversation?.messages.map((message) => message.content)).toEqual(['hello', 'world']);
      expect(existsSync(join(dir, 'conversations', 'conv-1', 'messages.jsonl'))).toBe(true);
      expect(existsSync(`${dbPath}.bak`)).toBe(true);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores per-turn journal entries in plain JSONL files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conversation-journal-'));
    try {
      const fileStore = new ConversationStore(dir);
      const conversation = fileStore.create();
      fileStore.appendTurnJournalEntry(conversation.id, 'turn-1', {
        turnId: 'turn-1',
        attempt: 1,
        timestamp: 123,
        type: 'turn_started',
        summary: 'Turn started.',
      });
      fileStore.appendTurnJournalEntry(conversation.id, 'turn-1', {
        turnId: 'turn-1',
        attempt: 1,
        timestamp: 124,
        type: 'boundary',
        summary: 'Opened the X profile page.',
        data: { url: 'https://x.com/CereWorkerX' },
      });

      expect(fileStore.getTurnJournal(conversation.id, 'turn-1')).toEqual([
        expect.objectContaining({ type: 'turn_started', summary: 'Turn started.' }),
        expect.objectContaining({ type: 'boundary', summary: 'Opened the X profile page.' }),
      ]);
      expect(existsSync(join(dir, 'conversations', conversation.id, 'turns', 'turn-1.jsonl'))).toBe(
        true,
      );
      fileStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
