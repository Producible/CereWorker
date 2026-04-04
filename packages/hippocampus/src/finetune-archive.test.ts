import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FineTuneArchiveStore } from './finetune-archive.js';
import type { TrainingPair } from './types.js';

describe('FineTuneArchiveStore', () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore(): FineTuneArchiveStore {
    dir = mkdtempSync(join(tmpdir(), 'cereworker-finetune-archive-'));
    return new FineTuneArchiveStore(dir);
  }

  function makePair(source: string, instruction: string): TrainingPair {
    return {
      instruction,
      response: `${instruction} response`,
      source,
      createdAt: 1,
      instanceId: 'instance-1',
      sessionId: 'session-1',
      exampleClass: 'conversation',
    };
  }

  it('queues pairs by source and deduplicates identical entries', () => {
    const store = makeStore();
    store.enqueue('discovery', [makePair('discovery', 'hello')]);
    store.enqueue('discovery', [makePair('discovery', 'hello')]);
    store.enqueue('conversations', [makePair('conversation:1', 'question')]);

    const batch = store.getQueuedBatch();
    expect(batch.bySource.discovery).toHaveLength(1);
    expect(batch.bySource.conversations).toHaveLength(1);
    expect(batch.pairs).toHaveLength(2);
  });

  it('creates an immutable round archive from the exact queued batch and clears it', () => {
    const store = makeStore();
    store.enqueue('curated-memory', [makePair('MEMORY.md', 'curated fact')]);
    store.enqueue('conversations', [makePair('conversation:abc', 'conv fact')]);

    const batch = store.getQueuedBatch();
    const manifest = store.createRound(batch, {
      jobId: 'ft-123',
      requestedMethod: 'auto',
      instanceId: 'instance-1',
      activeCheckpointBefore: '/checkpoints/base',
    });
    store.clearBatch(batch);

    expect(manifest.totalPairs).toBe(2);
    expect(manifest.instanceId).toBe('instance-1');
    expect(manifest.activeCheckpointBefore).toBe('/checkpoints/base');
    expect(manifest.exampleClassCounts?.conversation).toBe(2);
    expect(readFileSync(join(dir, 'rounds', 'ft-123', 'training.jsonl'), 'utf-8')).toContain('curated fact');
    expect(readFileSync(join(dir, 'rounds', 'ft-123', 'sources', 'curated-memory.jsonl'), 'utf-8')).toContain('curated fact');
    expect(store.getQueuedBatch().pairs).toHaveLength(0);
  });

  it('updates manifest status after a round completes', () => {
    const store = makeStore();
    store.enqueue('discovery', [makePair('discovery', 'seed')]);
    const batch = store.getQueuedBatch();
    store.createRound(batch, { jobId: 'ft-456', requestedMethod: 'lora', instanceId: 'instance-1' });
    const updated = store.updateRoundStatus('ft-456', {
      status: 'completed',
      completedAt: '2026-03-30T00:00:00.000Z',
      checkpointPath: '/checkpoints/ft-456',
      loss: 0.42,
    });

    expect(updated.status).toBe('completed');
    expect(updated.loss).toBe(0.42);
    expect(updated.checkpointPath).toBe('/checkpoints/ft-456');
  });
});
