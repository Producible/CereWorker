import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  ensureDir,
  readJsonFile,
  withTextStoreLock,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from '@producible/cereworker-core';
import type { TrainingPair } from './types.js';

export type FineTuneQueueSource = 'discovery' | 'conversations' | 'curated-memory';

export interface FineTuneQueuedBatch {
  pairs: TrainingPair[];
  bySource: Record<FineTuneQueueSource, TrainingPair[]>;
}

export interface FineTuneRoundManifest {
  roundId: string;
  jobId: string;
  instanceId?: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  startedAt: string;
  completedAt?: string;
  requestedMethod?: string;
  activeCheckpointBefore?: string | null;
  totalPairs: number;
  sourceCounts: Record<FineTuneQueueSource, number>;
  exampleClassCounts?: Record<string, number>;
  checkpointPath?: string;
  loss?: number;
  error?: string;
}

const SOURCE_ORDER: FineTuneQueueSource[] = ['discovery', 'curated-memory', 'conversations'];
const SOURCE_FILES: Record<FineTuneQueueSource, string> = {
  discovery: 'discovery.jsonl',
  conversations: 'conversations.jsonl',
  'curated-memory': 'curated-memory.jsonl',
};

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, homedir());
}

function serializePair(pair: TrainingPair): string {
  return JSON.stringify({
    instruction: pair.instruction,
    response: pair.response,
    source: pair.source,
    createdAt: pair.createdAt,
    instanceId: pair.instanceId,
    sessionId: pair.sessionId,
    exampleClass: pair.exampleClass,
  });
}

function pairIdentity(pair: TrainingPair): string {
  return [
    pair.instruction,
    pair.response,
    pair.source,
    pair.instanceId ?? '',
    pair.sessionId ?? '',
    pair.exampleClass ?? '',
  ].join('\u0000');
}

function readPairs(path: string): TrainingPair[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .map((line: string) => {
      try {
        return JSON.parse(line) as TrainingPair;
      } catch {
        return null;
      }
    })
    .filter((pair: TrainingPair | null): pair is TrainingPair => pair !== null);
}

function writePairs(path: string, pairs: TrainingPair[]): void {
  const content = pairs.length > 0
    ? pairs.map((pair) => serializePair(pair)).join('\n') + '\n'
    : '';
  writeTextFileAtomic(path, content);
}

export class FineTuneArchiveStore {
  private readonly rootDir: string;
  private readonly queueDir: string;
  private readonly roundsDir: string;
  private readonly stateDir: string;

  constructor(directory: string) {
    this.rootDir = resolve(expandHome(directory));
    this.queueDir = join(this.rootDir, 'queue');
    this.roundsDir = join(this.rootDir, 'rounds');
    this.stateDir = join(this.rootDir, 'state');

    ensureDir(this.rootDir);
    ensureDir(this.queueDir);
    ensureDir(this.roundsDir);
    ensureDir(this.stateDir);
  }

  get directory(): string {
    return this.rootDir;
  }

  getConversationExtractorStatePath(): string {
    return join(this.stateDir, 'conversation-extractor.json');
  }

  enqueue(source: FineTuneQueueSource, pairs: TrainingPair[]): { added: number; total: number } {
    if (pairs.length === 0) {
      return { added: 0, total: this.getQueuedBatch().pairs.length };
    }

    const path = this.getQueuePath(source);
    return withTextStoreLock(this.queueDir, () => {
      const existing = readPairs(path);
      const seen = new Set(existing.map((pair) => pairIdentity(pair)));
      const unique = pairs.filter((pair) => {
        const key = pairIdentity(pair);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const next = unique.length > 0 ? [...existing, ...unique] : existing;
      if (unique.length > 0) {
        writePairs(path, next);
      }

      const sourceCounts = {
        discovery: source === 'discovery' ? next.length : readPairs(this.getQueuePath('discovery')).length,
        conversations: source === 'conversations' ? next.length : readPairs(this.getQueuePath('conversations')).length,
        'curated-memory': source === 'curated-memory' ? next.length : readPairs(this.getQueuePath('curated-memory')).length,
      };

      return {
        added: unique.length,
        total: SOURCE_ORDER.reduce((sum, key) => sum + sourceCounts[key], 0),
      };
    });
  }

  getQueuedBatch(): FineTuneQueuedBatch {
    const bySource = {
      discovery: readPairs(this.getQueuePath('discovery')),
      conversations: readPairs(this.getQueuePath('conversations')),
      'curated-memory': readPairs(this.getQueuePath('curated-memory')),
    };

    return {
      pairs: SOURCE_ORDER.flatMap((source) => bySource[source]),
      bySource,
    };
  }

  clearBatch(batch: FineTuneQueuedBatch): void {
    withTextStoreLock(this.queueDir, () => {
      for (const source of SOURCE_ORDER) {
        const path = this.getQueuePath(source);
        const existing = readPairs(path);
        if (existing.length === 0) continue;

        const removals = new Map<string, number>();
        for (const pair of batch.bySource[source]) {
          const key = serializePair(pair);
          removals.set(key, (removals.get(key) ?? 0) + 1);
        }

        const remaining: TrainingPair[] = [];
        for (const pair of existing) {
          const key = serializePair(pair);
          const count = removals.get(key) ?? 0;
          if (count > 0) {
            removals.set(key, count - 1);
            continue;
          }
          remaining.push(pair);
        }

        writePairs(path, remaining);
      }
    });
  }

  createRound(
    batch: FineTuneQueuedBatch,
    options: { jobId: string; requestedMethod?: string; instanceId?: string; activeCheckpointBefore?: string | null },
  ): FineTuneRoundManifest {
    const roundId = options.jobId || `round-${randomUUID()}`;
    const roundDir = join(this.roundsDir, roundId);
    return withTextStoreLock(roundDir, () => {
      const sourcesDir = join(roundDir, 'sources');
      ensureDir(sourcesDir);
      const exampleClassCounts = batch.pairs.reduce<Record<string, number>>((counts, pair) => {
        const key = pair.exampleClass ?? 'unspecified';
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {});

      const manifest: FineTuneRoundManifest = {
        roundId,
        jobId: options.jobId,
        instanceId: options.instanceId,
        status: 'running',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        requestedMethod: options.requestedMethod,
        activeCheckpointBefore: options.activeCheckpointBefore,
        totalPairs: batch.pairs.length,
        sourceCounts: {
          discovery: batch.bySource.discovery.length,
          conversations: batch.bySource.conversations.length,
          'curated-memory': batch.bySource['curated-memory'].length,
        },
        exampleClassCounts,
      };

      writePairs(join(roundDir, 'training.jsonl'), batch.pairs);
      for (const source of SOURCE_ORDER) {
        writePairs(join(sourcesDir, SOURCE_FILES[source]), batch.bySource[source]);
      }
      writeJsonFileAtomic(join(roundDir, 'manifest.json'), manifest);
      return manifest;
    });
  }

  updateRoundStatus(
    roundId: string,
    patch: Partial<Pick<FineTuneRoundManifest, 'status' | 'completedAt' | 'checkpointPath' | 'loss' | 'error'>>,
  ): FineTuneRoundManifest {
    const manifestPath = join(this.roundsDir, roundId, 'manifest.json');
    return withTextStoreLock(join(this.roundsDir, roundId), () => {
      const manifest = readJsonFile<FineTuneRoundManifest | null>(manifestPath, null);
      if (!manifest) {
        throw new Error(`Fine-tune round not found: ${roundId}`);
      }
      const updated: FineTuneRoundManifest = {
        ...manifest,
        ...patch,
      };
      writeJsonFileAtomic(manifestPath, updated);
      return updated;
    });
  }

  private getQueuePath(source: FineTuneQueueSource): string {
    return join(this.queueDir, SOURCE_FILES[source]);
  }
}
