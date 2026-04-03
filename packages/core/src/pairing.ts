import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';
import {
  ensureDir,
  readJsonLines,
  resolveStoreBasePath,
  withTextStoreLock,
  writeJsonLines,
} from './text-store.js';
import { markLegacySectionMigrated, readLegacySection } from './legacy-sqlite.js';

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

interface ApprovedUser {
  channelId: string;
  senderId: string;
  approvedAt: number;
  approvedVia?: string;
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
  private readonly pairingDir: string;
  private readonly requestsPath: string | null;
  private readonly approvedUsersPath: string | null;
  private requests: PairingRequest[] = [];
  private approvedUsers: ApprovedUser[] = [];

  constructor(dbPath?: string) {
    const baseDir = resolveStoreBasePath(dbPath ?? DEFAULT_DB_PATH);
    this.pairingDir = join(baseDir, 'pairing');
    ensureDir(this.pairingDir);

    this.requestsPath = join(this.pairingDir, 'requests.jsonl');
    this.approvedUsersPath = join(this.pairingDir, 'approved-users.jsonl');

    this.migrateLegacyDatabase(dbPath ?? DEFAULT_DB_PATH);
    this.refreshFromDisk();
    log.info('Opened pairing store', { path: this.pairingDir });
  }

  private migrateLegacyDatabase(dbPath: string): void {
    const migrated = readLegacySection(
      dbPath,
      'pairing',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db: any) => {
        const tableRows = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>;
        const tableNames = new Set(tableRows.map((row) => row.name));

        return {
          requests: tableNames.has('pairing_requests')
            ? (
              db.prepare(
                `SELECT code, channelId, senderId, senderName, createdAt, expiresAt, status
                 FROM pairing_requests ORDER BY createdAt DESC`,
              ).all() as PairingRequest[]
            )
            : [],
          approvedUsers: tableNames.has('approved_users')
            ? (
              db.prepare(
                `SELECT channelId, senderId, approvedAt, approvedVia
                 FROM approved_users ORDER BY approvedAt ASC`,
              ).all() as ApprovedUser[]
            )
            : [],
        };
      },
    );

    if (!migrated) return;

    if (!existsSync(this.requestsPath!)) {
      writeJsonLines(this.requestsPath!, migrated.requests);
    }
    if (!existsSync(this.approvedUsersPath!)) {
      writeJsonLines(this.approvedUsersPath!, migrated.approvedUsers);
    }

    markLegacySectionMigrated(dbPath, 'pairing');
  }

  createPairingCode(channelId: string, senderId: string, senderName?: string): string | null {
    return this.withMutation(() => {
      this.expireStaleInMemory();

      const existing = this.requests.find(
        (request) =>
          request.channelId === channelId
          && request.senderId === senderId
          && request.status === 'pending'
          && request.expiresAt > Date.now(),
      );

      if (existing) {
        return formatCode(existing.code);
      }

      const pendingCount = this.requests.filter(
        (request) =>
          request.channelId === channelId
          && request.status === 'pending'
          && request.expiresAt > Date.now(),
      ).length;

      if (pendingCount >= MAX_PENDING_PER_CHANNEL) {
        log.warn('Pairing rate limit reached', { channelId, pending: pendingCount });
        return null;
      }

      let code: string;
      let attempts = 0;
      do {
        code = generateCode();
        attempts++;
        if (attempts > 100) {
          log.warn('Failed to generate unique pairing code');
          return null;
        }
      } while (this.requests.some((request) => request.code === code));

      const now = Date.now();
      this.requests.unshift({
        code,
        channelId,
        senderId,
        senderName: senderName ?? null,
        createdAt: now,
        expiresAt: now + CODE_TTL_MS,
        status: 'pending',
      });
      this.persistRequests();

      log.info('Pairing code created', { channelId, senderId, code: formatCode(code) });
      return formatCode(code);
    });
  }

  getPendingByCode(code: string): PairingRequest | null {
    this.refreshFromDisk();
    const normalized = normalizeCode(code);
    return this.requests.find(
      (request) =>
        request.code === normalized
        && request.status === 'pending'
        && request.expiresAt > Date.now(),
    ) ?? null;
  }

  listPending(): PairingRequest[] {
    this.refreshFromDisk();
    return this.requests
      .filter((request) => request.status === 'pending' && request.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  approveCode(code: string): ApprovalResult {
    return this.withMutation(() => {
      const normalized = normalizeCode(code);
      this.expireStaleInMemory();

      const request = this.requests.find(
        (item) =>
          item.code === normalized
          && item.status === 'pending'
          && item.expiresAt > Date.now(),
      );

      if (!request) {
        return { ok: false, error: 'Code not found or expired' };
      }

      request.status = 'approved';
      this.persistRequests();

      if (!this.approvedUsers.some((user) => user.channelId === request.channelId && user.senderId === request.senderId)) {
        this.approvedUsers.push({
          channelId: request.channelId,
          senderId: request.senderId,
          approvedAt: Date.now(),
          approvedVia: 'pairing',
        });
        this.persistApprovedUsers();
      }

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
    });
  }

  isApproved(channelId: string, senderId: string): boolean {
    this.refreshFromDisk();
    return this.approvedUsers.some((user) => user.channelId === channelId && user.senderId === senderId);
  }

  expireStale(): number {
    return this.withMutation(() => this.expireStaleInMemory());
  }

  addConfigUser(channelId: string, senderId: string): void {
    this.withMutation(() => {
      if (this.approvedUsers.some((user) => user.channelId === channelId && user.senderId === senderId)) {
        return;
      }
      this.approvedUsers.push({
        channelId,
        senderId,
        approvedAt: Date.now(),
        approvedVia: 'config',
      });
      this.persistApprovedUsers();
    });
  }

  close(): void {
    // No-op for file-backed store.
  }

  private persistRequests(): void {
    writeJsonLines(this.requestsPath!, this.requests);
  }

  private persistApprovedUsers(): void {
    writeJsonLines(this.approvedUsersPath!, this.approvedUsers);
  }

  private refreshFromDisk(): void {
    this.requests = readJsonLines<PairingRequest>(this.requestsPath!);
    this.approvedUsers = readJsonLines<ApprovedUser>(this.approvedUsersPath!);
  }

  private withMutation<T>(fn: () => T): T {
    return withTextStoreLock(this.pairingDir, () => {
      this.refreshFromDisk();
      return fn();
    });
  }

  private expireStaleInMemory(now: number = Date.now()): number {
    let changed = 0;
    for (const request of this.requests) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'expired';
        changed++;
      }
    }
    if (changed > 0) {
      this.persistRequests();
    }
    return changed;
  }
}
