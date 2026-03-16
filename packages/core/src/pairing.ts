import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createLogger } from './logger.js';

const log = createLogger('pairing');
const require = createRequire(import.meta.url);

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

const DEFAULT_DB_PATH = join(homedir(), '.cereworker', 'conversations.db');

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING_PER_CHANNEL = 3;

export interface PairingRequest {
  code: string;
  channelId: string;
  senderId: string;
  senderName: string | null;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'expired';
}

export interface ApprovalResult {
  ok: boolean;
  channelId?: string;
  senderId?: string;
  senderName?: string | null;
  error?: string;
}

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase();
}

function tryOpenDb(dbPath: string): SqliteDb | null {
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath) as SqliteDb;
  } catch {
    return null;
  }
}

export class PairingStore {
  private db: SqliteDb | null;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    this.db = tryOpenDb(path);
    if (this.db) {
      this.db.pragma('journal_mode = WAL');
      this.ensureSchema();
      log.info('Opened pairing database', { path });
    } else {
      log.warn('better-sqlite3 not available — pairing will be disabled. Run "cereworker onboard" to install build tools.');
    }
  }

  private ensureSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS pairing_requests (
        code TEXT PRIMARY KEY,
        channelId TEXT NOT NULL,
        senderId TEXT NOT NULL,
        senderName TEXT,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_channel_sender
        ON pairing_requests(channelId, senderId, status);
      CREATE INDEX IF NOT EXISTS idx_pairing_status
        ON pairing_requests(status, expiresAt);

      CREATE TABLE IF NOT EXISTS approved_users (
        channelId TEXT NOT NULL,
        senderId TEXT NOT NULL,
        approvedAt INTEGER NOT NULL,
        approvedVia TEXT,
        PRIMARY KEY (channelId, senderId)
      );
    `);
  }

  createPairingCode(channelId: string, senderId: string, senderName?: string): string | null {
    if (!this.db) return null;
    this.expireStale();

    // Check for existing pending code for this sender+channel
    const existing = this.db.prepare(
      `SELECT code FROM pairing_requests WHERE channelId = ? AND senderId = ? AND status = 'pending' AND expiresAt > ?`,
    ).get(channelId, senderId, Date.now()) as { code: string } | undefined;

    if (existing) {
      return formatCode(existing.code);
    }

    // Check rate limit per channel
    const pendingCount = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM pairing_requests WHERE channelId = ? AND status = 'pending' AND expiresAt > ?`,
    ).get(channelId, Date.now()) as { cnt: number };

    if (pendingCount.cnt >= MAX_PENDING_PER_CHANNEL) {
      log.warn('Pairing rate limit reached', { channelId, pending: pendingCount.cnt });
      return null;
    }

    // Generate unique code
    let code: string;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
      if (attempts > 100) {
        log.warn('Failed to generate unique pairing code');
        return null;
      }
    } while (
      this.db.prepare(`SELECT 1 FROM pairing_requests WHERE code = ?`).get(code)
    );

    const now = Date.now();
    this.db.prepare(
      `INSERT INTO pairing_requests (code, channelId, senderId, senderName, createdAt, expiresAt, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(code, channelId, senderId, senderName ?? null, now, now + CODE_TTL_MS);

    log.info('Pairing code created', { channelId, senderId, code: formatCode(code) });
    return formatCode(code);
  }

  getPendingByCode(code: string): PairingRequest | null {
    if (!this.db) return null;
    const normalized = normalizeCode(code);
    const row = this.db.prepare(
      `SELECT * FROM pairing_requests WHERE code = ? AND status = 'pending' AND expiresAt > ?`,
    ).get(normalized, Date.now()) as PairingRequest | undefined;
    return row ?? null;
  }

  listPending(): PairingRequest[] {
    if (!this.db) return [];
    return this.db.prepare(
      `SELECT * FROM pairing_requests WHERE status = 'pending' AND expiresAt > ? ORDER BY createdAt DESC`,
    ).all(Date.now()) as PairingRequest[];
  }

  approveCode(code: string): ApprovalResult {
    if (!this.db) return { ok: false, error: 'Pairing unavailable (database not available)' };
    const normalized = normalizeCode(code);
    this.expireStale();

    const request = this.db.prepare(
      `SELECT * FROM pairing_requests WHERE code = ? AND status = 'pending' AND expiresAt > ?`,
    ).get(normalized, Date.now()) as PairingRequest | undefined;

    if (!request) {
      return { ok: false, error: 'Code not found or expired' };
    }

    // Mark as approved
    this.db.prepare(
      `UPDATE pairing_requests SET status = 'approved' WHERE code = ?`,
    ).run(normalized);

    // Add to approved users
    this.db.prepare(
      `INSERT OR IGNORE INTO approved_users (channelId, senderId, approvedAt, approvedVia)
       VALUES (?, ?, ?, 'pairing')`,
    ).run(request.channelId, request.senderId, Date.now());

    log.info('Pairing approved', {
      channelId: request.channelId,
      senderId: request.senderId,
      senderName: request.senderName,
    });

    return {
      ok: true,
      channelId: request.channelId,
      senderId: request.senderId,
      senderName: request.senderName,
    };
  }

  isApproved(channelId: string, senderId: string): boolean {
    if (!this.db) return true;
    const row = this.db.prepare(
      `SELECT 1 FROM approved_users WHERE channelId = ? AND senderId = ?`,
    ).get(channelId, senderId);
    return !!row;
  }

  expireStale(): number {
    if (!this.db) return 0;
    const result = this.db.prepare(
      `UPDATE pairing_requests SET status = 'expired' WHERE status = 'pending' AND expiresAt <= ?`,
    ).run(Date.now());
    return result.changes;
  }

  addConfigUser(channelId: string, senderId: string): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT OR IGNORE INTO approved_users (channelId, senderId, approvedAt, approvedVia)
       VALUES (?, ?, ?, 'config')`,
    ).run(channelId, senderId, Date.now());
  }

  close(): void {
    this.db?.close();
  }
}
