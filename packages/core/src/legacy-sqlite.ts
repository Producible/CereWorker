import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import { ensureDir, readFileHeader, readJsonFile, uniqueBackupPath, writeJsonFileAtomic } from './text-store.js';

const require = createRequire(import.meta.url);

export type LegacyMigrationSection = 'conversations' | 'pairing' | 'plans';

interface MigrationState {
  requiredSections: LegacyMigrationSection[];
  migratedSections: Partial<Record<LegacyMigrationSection, boolean>>;
  backupPath?: string;
  completedAt?: string;
}

function openDatabase(path: string) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path);
}

function getStatePath(dbPath: string): string {
  return join(
    dirname(dbPath),
    `.${basename(dbPath)}.migration.json`,
  );
}

function readState(dbPath: string): MigrationState {
  return readJsonFile<MigrationState>(getStatePath(dbPath), {
    requiredSections: [],
    migratedSections: {},
  });
}

function writeState(dbPath: string, state: MigrationState): void {
  writeJsonFileAtomic(getStatePath(dbPath), state);
}

export function isLegacySqliteDatabase(path: string): boolean {
  if (!existsSync(path)) return false;
  return readFileHeader(path, 16).toString('utf-8') === 'SQLite format 3\u0000';
}

export function detectLegacySections(dbPath: string): LegacyMigrationSection[] {
  if (!isLegacySqliteDatabase(dbPath)) return [];
  const db = openDatabase(dbPath);
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    const sections: LegacyMigrationSection[] = [];
    if (names.has('conversations') || names.has('messages')) {
      sections.push('conversations');
    }
    if (names.has('pairing_requests') || names.has('approved_users')) {
      sections.push('pairing');
    }
    if (names.has('plans')) {
      sections.push('plans');
    }
    return sections;
  } finally {
    db.close();
  }
}

export function readLegacySection<T>(dbPath: string, section: LegacyMigrationSection, reader: (db: unknown) => T): T | null {
  if (!isLegacySqliteDatabase(dbPath)) return null;
  const requiredSections = detectLegacySections(dbPath);
  if (!requiredSections.includes(section)) return null;

  const state = readState(dbPath);
  if (state.requiredSections.length === 0) {
    state.requiredSections = requiredSections;
    writeState(dbPath, state);
  }
  if (state.migratedSections[section]) return null;

  const db = openDatabase(dbPath);
  try {
    return reader(db);
  } finally {
    db.close();
  }
}

export function markLegacySectionMigrated(dbPath: string, section: LegacyMigrationSection): void {
  const requiredSections = detectLegacySections(dbPath);
  if (requiredSections.length === 0) return;

  const state = readState(dbPath);
  state.requiredSections = requiredSections;
  state.migratedSections[section] = true;

  const allDone = requiredSections.every((required) => state.migratedSections[required]);
  if (allDone && existsSync(dbPath)) {
    ensureDir(dirname(dbPath));
    const backupPath = uniqueBackupPath(dbPath);
    renameSync(dbPath, backupPath);
    state.backupPath = backupPath;
    state.completedAt = new Date().toISOString();
  }

  writeState(dbPath, state);
}
