import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingStore, formatCode, normalizeCode } from './pairing.js';

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
      // Backdate via raw SQL
      const db = (store as any).db;
      db.prepare(`UPDATE pairing_requests SET expiresAt = 0`).run();
      const count = store.expireStale();
      expect(count).toBe(1);
      expect(store.listPending()).toHaveLength(0);
    });
  });
});
