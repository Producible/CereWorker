import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InstanceStore } from './instance.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `cereworker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('InstanceStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it('returns null when instance.json does not exist', () => {
    const store = new InstanceStore(dir);
    expect(store.load()).toBeNull();
  });

  it('creates a new instance with static profile', () => {
    const store = new InstanceStore(dir);
    const instance = store.create({ name: 'TestBot', role: 'tester', traits: ['precise'] });

    expect(instance.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(instance.profile.name).toBe('TestBot');
    expect(instance.profile.role).toBe('tester');
    expect(instance.profile.traits).toEqual(['precise']);
    expect(instance.profile.source).toBe('static');
    expect(instance.conversationCount).toBe(0);
    expect(instance.finetuneLineage).toEqual([]);
    expect(instance.activeCheckpoint).toBeNull();
    expect(instance.schemaVersion).toBe(1);

    // File should exist on disk
    expect(existsSync(join(dir, 'instance.json'))).toBe(true);
  });

  it('creates a new instance with discovered profile', () => {
    const store = new InstanceStore(dir);
    const instance = store.create({ name: 'Disco', role: 'helper', traits: [] }, 'discovered');
    expect(instance.profile.source).toBe('discovered');
  });

  it('loads an existing instance from disk', () => {
    const store1 = new InstanceStore(dir);
    const created = store1.create({ name: 'Bot', role: 'worker', traits: [] });

    const store2 = new InstanceStore(dir);
    const loaded = store2.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(created.id);
    expect(loaded!.profile.name).toBe('Bot');
  });

  it('get() returns current identity after load', () => {
    const store = new InstanceStore(dir);
    expect(store.get()).toBeNull();

    store.create({ name: 'A', role: 'r', traits: [] });
    expect(store.get()).not.toBeNull();
    expect(store.get()!.profile.name).toBe('A');
  });

  it('updateBoot() updates lastBootAt', () => {
    const store = new InstanceStore(dir);
    store.create({ name: 'A', role: 'r', traits: [] });

    // Override lastBootAt to a known old value to avoid same-millisecond issue
    store.get()!.lastBootAt = '2020-01-01T00:00:00.000Z';
    store.save();

    store.updateBoot();
    const updated = store.get()!;
    expect(updated.lastBootAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(updated.lastBootAt).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it('recordFineTune() appends to lineage and sets activeCheckpoint', () => {
    const store = new InstanceStore(dir);
    store.create({ name: 'A', role: 'r', traits: [] });

    store.recordFineTune({
      jobId: 'ft-001',
      method: 'lora',
      completedAt: '2026-03-25T12:00:00Z',
      checkpointPath: '/checkpoints/ft-001',
      loss: 0.42,
      trainingPairs: 50,
    });

    const identity = store.get()!;
    expect(identity.finetuneLineage).toHaveLength(1);
    expect(identity.finetuneLineage[0].jobId).toBe('ft-001');
    expect(identity.activeCheckpoint).toBe('/checkpoints/ft-001');

    // Add a second
    store.recordFineTune({
      jobId: 'ft-002',
      method: 'qlora',
      completedAt: '2026-03-26T12:00:00Z',
      checkpointPath: '/checkpoints/ft-002',
      loss: 0.35,
      trainingPairs: 80,
    });

    expect(store.get()!.finetuneLineage).toHaveLength(2);
    expect(store.get()!.activeCheckpoint).toBe('/checkpoints/ft-002');
  });

  it('incrementConversation() bumps the counter', () => {
    const store = new InstanceStore(dir);
    store.create({ name: 'A', role: 'r', traits: [] });

    store.incrementConversation();
    expect(store.get()!.conversationCount).toBe(1);

    store.incrementConversation();
    store.incrementConversation();
    expect(store.get()!.conversationCount).toBe(3);
  });

  it('updateProfile() merges profile fields', () => {
    const store = new InstanceStore(dir);
    store.create({ name: 'OldName', role: 'old-role', traits: ['a'] });

    store.updateProfile({ name: 'NewName' });
    expect(store.get()!.profile.name).toBe('NewName');
    expect(store.get()!.profile.role).toBe('old-role'); // unchanged

    store.updateProfile({ role: 'new-role', source: 'discovered' });
    expect(store.get()!.profile.role).toBe('new-role');
    expect(store.get()!.profile.source).toBe('discovered');
  });

  it('setConversationCount() sets count directly', () => {
    const store = new InstanceStore(dir);
    store.create({ name: 'A', role: 'r', traits: [] });
    store.setConversationCount(42);
    expect(store.get()!.conversationCount).toBe(42);
  });

  it('handles corrupted instance.json gracefully', () => {
    writeFileSync(join(dir, 'instance.json'), '{invalid json!!!', 'utf-8');
    const store = new InstanceStore(dir);
    expect(store.load()).toBeNull();
  });

  it('migrates pre-schema data (no schemaVersion)', () => {
    const oldData = {
      id: 'old-uuid',
      createdAt: '2025-01-01T00:00:00Z',
      profile: { name: 'Old', role: 'r', traits: [], source: 'static' },
    };
    writeFileSync(join(dir, 'instance.json'), JSON.stringify(oldData), 'utf-8');

    const store = new InstanceStore(dir);
    const instance = store.load();

    expect(instance).not.toBeNull();
    expect(instance!.id).toBe('old-uuid');
    expect(instance!.schemaVersion).toBe(1);
    expect(instance!.conversationCount).toBe(0);
    expect(instance!.finetuneLineage).toEqual([]);
    expect(instance!.activeCheckpoint).toBeNull();
  });

  it('persists changes across store instances', () => {
    const store1 = new InstanceStore(dir);
    store1.create({ name: 'Persist', role: 'test', traits: ['a', 'b'] });
    store1.incrementConversation();
    store1.recordFineTune({
      jobId: 'ft-x',
      method: 'full',
      completedAt: '2026-01-01T00:00:00Z',
      checkpointPath: '/cp/x',
      loss: 0.5,
      trainingPairs: 10,
    });

    // New store instance reads from disk
    const store2 = new InstanceStore(dir);
    const loaded = store2.load()!;
    expect(loaded.profile.name).toBe('Persist');
    expect(loaded.conversationCount).toBe(1);
    expect(loaded.finetuneLineage).toHaveLength(1);
    expect(loaded.activeCheckpoint).toBe('/cp/x');
  });

  it('does nothing when identity is not loaded', () => {
    const store = new InstanceStore(dir);
    // None of these should throw
    store.updateBoot();
    store.recordFineTune({
      jobId: 'x', method: 'lora', completedAt: '', checkpointPath: '', loss: 0, trainingPairs: 0,
    });
    store.incrementConversation();
    store.updateProfile({ name: 'X' });
    store.setConversationCount(5);
    store.save();
    expect(store.get()).toBeNull();
  });

  it('creates parent directory if it does not exist', () => {
    const nested = join(dir, 'deep', 'nested');
    const store = new InstanceStore(nested);
    store.create({ name: 'A', role: 'r', traits: [] });
    expect(existsSync(join(nested, 'instance.json'))).toBe(true);
  });
});
