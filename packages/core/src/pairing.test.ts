import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingStore, formatCode, normalizeCode } from './pairing.js';
import { ConversationStore } from './conversation.js';

const require = createRequire(import.meta.url);

describe('PairingStore', () => {
  let dir: string;
  let store: PairingStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pairing-test-'));
    store = new PairingStore(join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('formatCode / normalizeCode', () => {
    it('formats code with dash separator', () => {
      expect(formatCode('ABCD1234')).toBe('ABCD-1234');
    });

    it('normalizes code by removing dashes and uppercasing', () => {
      expect(normalizeCode('abcd-1234')).toBe('ABCD1234');
      expect(normalizeCode('ABCD 1234')).toBe('ABCD1234');
      expect(normalizeCode('abcd1234')).toBe('ABCD1234');
    });
  });

  describe('createPairingCode', () => {
    it('generates a formatted code', () => {
      const code = store.createPairingCode('telegram', '12345');
      expect(code).not.toBeNull();
      expect(code).toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
    });

    it('returns existing code for same sender+channel', () => {
      const code1 = store.createPairingCode('telegram', '12345');
      const code2 = store.createPairingCode('telegram', '12345');
      expect(code1).toBe(code2);
    });

    it('generates different codes for different senders', () => {
      const code1 = store.createPairingCode('telegram', '111');
      const code2 = store.createPairingCode('telegram', '222');
      expect(code1).not.toBe(code2);
    });

    it('stores senderName when provided', () => {
      const code = store.createPairingCode('telegram', '12345', 'alice');
      const pending = store.getPendingByCode(code!);
      expect(pending?.senderName).toBe('alice');
    });

    it('returns null when rate limit reached', () => {
      store.createPairingCode('telegram', '1');
      store.createPairingCode('telegram', '2');
      store.createPairingCode('telegram', '3');
      const code = store.createPairingCode('telegram', '4');
      expect(code).toBeNull();
    });

    it('rate limit is per channel', () => {
      store.createPairingCode('telegram', '1');
      store.createPairingCode('telegram', '2');
      store.createPairingCode('telegram', '3');
      const code = store.createPairingCode('discord', '4');
      expect(code).not.toBeNull();
    });

    it('reloads persisted state before mutating from another store instance', () => {
      const first = new PairingStore(join(dir, 'test.db'));
      const second = new PairingStore(join(dir, 'test.db'));
      try {
        const code = first.createPairingCode('telegram', '12345');
        expect(second.createPairingCode('telegram', '12345')).toBe(code);
        expect(second.getPendingByCode(code!)).not.toBeNull();
      } finally {
        first.close();
        second.close();
      }
    });
  });

  describe('getPendingByCode', () => {
    it('returns pending request', () => {
      const code = store.createPairingCode('telegram', '12345', 'bob');
      const pending = store.getPendingByCode(code!);
      expect(pending).not.toBeNull();
      expect(pending!.channelId).toBe('telegram');
      expect(pending!.senderId).toBe('12345');
      expect(pending!.senderName).toBe('bob');
      expect(pending!.status).toBe('pending');
    });

    it('accepts formatted code with dash', () => {
      const code = store.createPairingCode('telegram', '12345');
      const pending = store.getPendingByCode(code!);
      expect(pending).not.toBeNull();
    });

    it('returns null for unknown code', () => {
      expect(store.getPendingByCode('ZZZZ-ZZZZ')).toBeNull();
    });
  });

  describe('approveCode', () => {
    it('approves a valid code', () => {
      const code = store.createPairingCode('telegram', '12345', 'alice');
      const result = store.approveCode(code!);
      expect(result.ok).toBe(true);
      expect(result.channelId).toBe('telegram');
      expect(result.senderId).toBe('12345');
      expect(result.senderName).toBe('alice');
    });

    it('marks code as approved', () => {
      const code = store.createPairingCode('telegram', '12345');
      store.approveCode(code!);
      expect(store.getPendingByCode(code!)).toBeNull();
    });

    it('makes user approved', () => {
      const code = store.createPairingCode('telegram', '12345');
      store.approveCode(code!);
      expect(store.isApproved('telegram', '12345')).toBe(true);
    });

    it('returns error for unknown code', () => {
      const result = store.approveCode('ZZZZ-ZZZZ');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error for already approved code', () => {
      const code = store.createPairingCode('telegram', '12345');
      store.approveCode(code!);
      const result = store.approveCode(code!);
      expect(result.ok).toBe(false);
    });
  });

  describe('isApproved', () => {
    it('returns false for unknown user', () => {
      expect(store.isApproved('telegram', '99999')).toBe(false);
    });

    it('returns true after approval', () => {
      const code = store.createPairingCode('telegram', '12345');
      store.approveCode(code!);
      expect(store.isApproved('telegram', '12345')).toBe(true);
    });

    it('returns true for config-seeded user', () => {
      store.addConfigUser('telegram', '67890');
      expect(store.isApproved('telegram', '67890')).toBe(true);
    });

    it('is channel-scoped', () => {
      store.addConfigUser('telegram', '12345');
      expect(store.isApproved('telegram', '12345')).toBe(true);
      expect(store.isApproved('discord', '12345')).toBe(false);
    });
  });

  describe('addConfigUser', () => {
    it('is idempotent', () => {
      store.addConfigUser('telegram', '12345');
      store.addConfigUser('telegram', '12345');
      expect(store.isApproved('telegram', '12345')).toBe(true);
    });
  });

  describe('listPending', () => {
    it('returns all pending requests', () => {
      store.createPairingCode('telegram', '1');
      store.createPairingCode('telegram', '2');
      const pending = store.listPending();
      expect(pending).toHaveLength(2);
    });

    it('excludes approved requests', () => {
      const code = store.createPairingCode('telegram', '1');
      store.createPairingCode('telegram', '2');
      store.approveCode(code!);
      const pending = store.listPending();
      expect(pending).toHaveLength(1);
    });
  });

  describe('expireStale', () => {
    it('expires old codes', () => {
      // Create a code, then manually backdate it
      store.createPairingCode('telegram', '12345');
      (store as any).requests[0].expiresAt = 0;
      (store as any).persistRequests();
      const count = store.expireStale();
      expect(count).toBe(1);
      expect(store.listPending()).toHaveLength(0);
    });
  });

  it('migrates legacy SQLite pairing data into text files', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'pairing-migration-'));
    const dbPath = join(legacyDir, 'conversations.db');
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE pairing_requests (
          code TEXT PRIMARY KEY,
          channelId TEXT NOT NULL,
          senderId TEXT NOT NULL,
          senderName TEXT,
          createdAt INTEGER NOT NULL,
          expiresAt INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE approved_users (
          channelId TEXT NOT NULL,
          senderId TEXT NOT NULL,
          approvedAt INTEGER NOT NULL,
          approvedVia TEXT,
          PRIMARY KEY (channelId, senderId)
        );
      `);
      db.prepare(
        `INSERT INTO pairing_requests (code, channelId, senderId, senderName, createdAt, expiresAt, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('ABCD1234', 'telegram', '123', 'alice', 1, Date.now() + 10_000, 'pending');
      db.prepare(
        'INSERT INTO approved_users (channelId, senderId, approvedAt, approvedVia) VALUES (?, ?, ?, ?)',
      ).run('telegram', '456', 2, 'config');
      db.close();

      const migrated = new PairingStore(dbPath);
      expect(migrated.getPendingByCode('ABCD-1234')?.senderName).toBe('alice');
      expect(migrated.isApproved('telegram', '456')).toBe(true);
      migrated.close();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('waits to back up the shared legacy database until all present sections are migrated', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'pairing-conversation-shared-'));
    const dbPath = join(legacyDir, 'conversations.db');
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
        CREATE TABLE pairing_requests (
          code TEXT PRIMARY KEY,
          channelId TEXT NOT NULL,
          senderId TEXT NOT NULL,
          senderName TEXT,
          createdAt INTEGER NOT NULL,
          expiresAt INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );
      `);
      db.prepare('INSERT INTO conversations (id, createdAt, updatedAt) VALUES (?, ?, ?)')
        .run('conv-1', 1, 2);
      db.prepare(
        `INSERT INTO messages (id, conversationId, role, content, timestamp, toolCalls, toolResult, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('msg-1', 'conv-1', 'user', 'hello', 10, null, null, null);
      db.prepare(
        `INSERT INTO pairing_requests (code, channelId, senderId, senderName, createdAt, expiresAt, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('ABCD1234', 'telegram', '123', 'alice', 1, Date.now() + 10_000, 'pending');
      db.close();

      const conversationStore = new ConversationStore(dbPath);
      expect(existsSync(dbPath)).toBe(true);

      const pairingStore = new PairingStore(dbPath);
      expect(pairingStore.getPendingByCode('ABCD-1234')?.senderName).toBe('alice');
      expect(existsSync(`${dbPath}.bak`)).toBe(true);

      conversationStore.close();
      pairingStore.close();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

});
