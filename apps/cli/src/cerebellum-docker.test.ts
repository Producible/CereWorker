import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CereWorkerConfig } from '@producible/cereworker-config';
import { describe, expect, it } from 'vitest';
import {
  buildCerebellumComposeCommand,
  buildCerebellumComposeEnv,
  getOfficialCerebellumImage,
  resolveCerebellumDockerImage,
  resolveCerebellumDockerModel,
} from './cerebellum-docker.js';

const config = {
  cerebellum: {
    enabled: true,
    address: 'localhost:50051',
    heartbeatInterval: 45,
    model: {
      source: 'huggingface',
      id: 'Qwen/Qwen3-1.7B',
    },
    finetune: {
      enabled: true,
      method: 'auto',
      schedule: 'auto',
    },
    verification: {
      enabled: true,
      timeoutMs: 5000,
    },
    docker: {
      autoStart: true,
      image: 'producible/cereworker-cerebellum:latest',
      modelsPath: '~/.cereworker/models',
    },
  },
} satisfies Pick<CereWorkerConfig, 'cerebellum'>;

describe('buildCerebellumComposeEnv', () => {
  it('passes the selected model and host cache path when it exists', () => {
    expect(
      buildCerebellumComposeEnv(config, {
        homeDir: '/home/tester',
        pathExists: () => true,
      }),
    ).toEqual({
      MODEL_PATH: 'Qwen/Qwen3-1.7B',
      HEARTBEAT_INTERVAL: '45',
      CEREWORKER_MODELS: '/home/tester/.cereworker/models',
    });
  });

  it('omits the host cache path when it does not exist', () => {
    expect(
      buildCerebellumComposeEnv(config, {
        homeDir: '/home/tester',
        pathExists: () => false,
      }),
    ).toEqual({
      MODEL_PATH: 'Qwen/Qwen3-1.7B',
      HEARTBEAT_INTERVAL: '45',
    });
  });
});

describe('resolveCerebellumDockerImage', () => {
  it('resolves official alias images to the current version at runtime', () => {
    expect(resolveCerebellumDockerImage(config, { version: '26.406.1' })).toEqual({
      configuredImage: 'producible/cereworker-cerebellum:latest',
      configuredStatusImage: 'producible/cereworker-cerebellum:latest',
      expectedImage: 'producible/cereworker-cerebellum:26.406.1',
      runtimeImage: 'producible/cereworker-cerebellum:26.406.1',
      localAlignmentImages: ['producible/cereworker-cerebellum:26.406.1', 'producible/cereworker-cerebellum:latest'],
      repo: 'producible/cereworker-cerebellum',
      variant: 'cpu',
      officialImage: true,
      aliasImage: true,
      customImage: false,
    });
  });

  it('preserves explicit version tags while still reporting the expected image', () => {
    expect(
      resolveCerebellumDockerImage(
        {
          cerebellum: {
            ...config.cerebellum,
            docker: {
              ...config.cerebellum.docker,
              image: 'producible/cereworker-cerebellum:26.405.0',
            },
          },
        },
        { version: '26.406.1' },
      ),
    ).toEqual({
      configuredImage: 'producible/cereworker-cerebellum:26.405.0',
      configuredStatusImage: 'producible/cereworker-cerebellum:26.405.0',
      expectedImage: 'producible/cereworker-cerebellum:26.406.1',
      runtimeImage: 'producible/cereworker-cerebellum:26.405.0',
      localAlignmentImages: ['producible/cereworker-cerebellum:26.405.0'],
      repo: 'producible/cereworker-cerebellum',
      variant: 'cpu',
      officialImage: true,
      aliasImage: false,
      customImage: false,
    });
  });

  it('builds the official versioned image reference for a variant', () => {
    expect(getOfficialCerebellumImage('cpu', { version: '26.406.1' })).toBe('producible/cereworker-cerebellum:26.406.1');
    expect(getOfficialCerebellumImage('gpu', { version: '26.406.1' })).toBe('producible/cereworker-cerebellum:26.406.1-gpu');
  });
});

describe('resolveCerebellumDockerModel', () => {
  it('prefers the mounted snapshot path when weights were predownloaded', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'cereworker-model-'));
    const repoDir = join(
      homeDir,
      '.cereworker',
      'models',
      'hub',
      'models--Qwen--Qwen3-1.7B',
    );

    mkdirSync(join(repoDir, 'refs'), { recursive: true });
    mkdirSync(join(repoDir, 'snapshots', 'abc123'), { recursive: true });
    writeFileSync(join(repoDir, 'refs', 'main'), 'abc123\n');

    try {
      expect(resolveCerebellumDockerModel(config, { homeDir })).toEqual({
        hostModelsPath: join(homeDir, '.cereworker', 'models'),
        modelPath: '/root/.cache/huggingface/hub/models--Qwen--Qwen3-1.7B/snapshots/abc123',
        usingPrefetchedCache: true,
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('falls back to the repo id when no cache snapshot exists', () => {
    expect(
      resolveCerebellumDockerModel(config, {
        homeDir: '/home/tester',
        pathExists: () => false,
      }),
    ).toEqual({
      hostModelsPath: '/home/tester/.cereworker/models',
      modelPath: 'Qwen/Qwen3-1.7B',
      usingPrefetchedCache: false,
    });
  });
});

describe('buildCerebellumComposeCommand', () => {
  it('injects env through sudo when docker requires elevation', () => {
    expect(
      buildCerebellumComposeCommand(
        '/workspace/docker-compose.yml',
        {
          MODEL_PATH: 'Qwen/Qwen3-1.7B',
          HEARTBEAT_INTERVAL: '45',
          CEREWORKER_MODELS: '/home/tester/.cereworker/models',
        },
        true,
      ),
    ).toEqual({
      command: 'sudo',
      args: [
        'env',
        'MODEL_PATH=Qwen/Qwen3-1.7B',
        'HEARTBEAT_INTERVAL=45',
        'CEREWORKER_MODELS=/home/tester/.cereworker/models',
        'docker',
        'compose',
        '-f',
        '/workspace/docker-compose.yml',
        'up',
        '-d',
        'cerebellum',
      ],
    });
  });

  it('uses process env directly without sudo', () => {
    const command = buildCerebellumComposeCommand(
      '/workspace/docker-compose.yml',
      { MODEL_PATH: 'Qwen/Qwen3-1.7B', HEARTBEAT_INTERVAL: '45' },
      false,
    );

    expect(command.command).toBe('docker');
    expect(command.args).toEqual(['compose', '-f', '/workspace/docker-compose.yml', 'up', '-d', 'cerebellum']);
    expect(command.env?.MODEL_PATH).toBe('Qwen/Qwen3-1.7B');
    expect(command.env?.HEARTBEAT_INTERVAL).toBe('45');
  });
});
