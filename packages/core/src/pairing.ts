import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';

const log = createLogger('pairing');

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

export class PairingStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.ensureSchema();
    log.info('Opened pairing database', { path });
  }

  private ensureSchema(): void {
    this.db.exec(`
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
    const normalized = normalizeCode(code);
    const row = this.db.prepare(
      `SELECT * FROM pairing_requests WHERE code = ? AND status = 'pending' AND expiresAt > ?`,
    ).get(normalized, Date.now()) as PairingRequest | undefined;
    return row ?? null;
  }

  listPending(): PairingRequest[] {
    return this.db.prepare(
      `SELECT * FROM pairing_requests WHERE status = 'pending' AND expiresAt > ? ORDER BY createdAt DESC`,
    ).all(Date.now()) as unknown as PairingRequest[];
  }

  approveCode(code: string): ApprovalResult {
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
    const row = this.db.prepare(
      `SELECT 1 FROM approved_users WHERE channelId = ? AND senderId = ?`,
    ).get(channelId, senderId);
    return !!row;
  }

  expireStale(): number {
    const result = this.db.prepare(
      `UPDATE pairing_requests SET status = 'expired' WHERE status = 'pending' AND expiresAt <= ?`,
    ).run(Date.now());
    return Number(result.changes);
  }

  addConfigUser(channelId: string, senderId: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO approved_users (channelId, senderId, approvedAt, approvedVia)
       VALUES (?, ?, ?, 'config')`,
    ).run(channelId, senderId, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
