import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('instance');

const CURRENT_SCHEMA_VERSION = 1;

export interface FineTuneRecord {
  jobId: string;
  method: string;
  completedAt: string;
  checkpointPath: string;
  loss: number;
  trainingPairs: number;
}

export interface InstanceProfile {
  name: string;
  role: string;
  traits: string[];
  source: 'static' | 'discovered';
}

export interface InstanceIdentity {
  id: string;
  createdAt: string;
  lastBootAt: string;
  profile: InstanceProfile;
  conversationCount: number;
  finetuneLineage: FineTuneRecord[];
  activeCheckpoint: string | null;
  schemaVersion: number;
}

export class InstanceStore {
  private filePath: string;
  private identity: InstanceIdentity | null = null;

  constructor(dir?: string) {
    const base = dir ?? join(homedir(), '.cereworker');
    this.filePath = join(base, 'instance.json');
  }

  /** Load instance identity from disk. Returns null if file doesn't exist or is corrupt. */
  load(): InstanceIdentity | null {
    if (!existsSync(this.filePath)) {
      return null;
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      this.identity = this.migrate(raw);
      return this.identity;
    } catch (err) {
      log.warn('Failed to load instance.json, will regenerate', { error: String(err) });
      return null;
    }
  }

  /** Create a new instance identity from a profile. */
  create(profile: { name: string; role: string; traits: string[] }, source: 'static' | 'discovered' = 'static'): InstanceIdentity {
    const now = new Date().toISOString();
    this.identity = {
      id: randomUUID(),
      createdAt: now,
      lastBootAt: now,
      profile: { ...profile, source },
      conversationCount: 0,
      finetuneLineage: [],
      activeCheckpoint: null,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
    this.save();
    log.info('Created new instance', { id: this.identity.id });
    return this.identity;
  }

  /** Get the current loaded identity (null if not loaded/created). */
  get(): InstanceIdentity | null {
    return this.identity;
  }

  /** Persist identity to disk with atomic write. */
  save(): void {
    if (!this.identity) return;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(this.identity, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  /** Update lastBootAt timestamp. */
  updateBoot(): void {
    if (!this.identity) return;
    this.identity.lastBootAt = new Date().toISOString();
    this.save();
  }

  /** Record a completed fine-tune job in the lineage. */
  recordFineTune(record: FineTuneRecord): void {
    if (!this.identity) return;
    this.identity.finetuneLineage.push(record);
    this.identity.activeCheckpoint = record.checkpointPath;
    this.save();
    log.info('Recorded fine-tune', { jobId: record.jobId, loss: record.loss });
  }

  /** Increment conversation counter. */
  incrementConversation(): void {
    if (!this.identity) return;
    this.identity.conversationCount++;
    this.save();
  }

  /** Update the instance profile. */
  updateProfile(profile: Partial<InstanceProfile>): void {
    if (!this.identity) return;
    this.identity.profile = { ...this.identity.profile, ...profile };
    this.save();
    log.info('Updated instance profile', { name: this.identity.profile.name });
  }

  /** Set conversation count directly (used for migration). */
  setConversationCount(count: number): void {
    if (!this.identity) return;
    this.identity.conversationCount = count;
    this.save();
  }

  /** Migrate older schema versions to current. */
  private migrate(raw: Record<string, unknown>): InstanceIdentity {
    const version = (raw.schemaVersion as number) ?? 0;

    if (version < 1) {
      // Pre-schema or v0: ensure all required fields exist
      return {
        id: (raw.id as string) ?? randomUUID(),
        createdAt: (raw.createdAt as string) ?? new Date().toISOString(),
        lastBootAt: (raw.lastBootAt as string) ?? new Date().toISOString(),
        profile: (raw.profile as InstanceProfile) ?? {
          name: 'Cere',
          role: 'general-purpose assistant',
          traits: [],
          source: 'static' as const,
        },
        conversationCount: (raw.conversationCount as number) ?? 0,
        finetuneLineage: (raw.finetuneLineage as FineTuneRecord[]) ?? [],
        activeCheckpoint: (raw.activeCheckpoint as string) ?? null,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
    }

    // Current version — pass through
    return raw as unknown as InstanceIdentity;
  }
}
