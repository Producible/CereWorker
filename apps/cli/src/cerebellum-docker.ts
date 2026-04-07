import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CereWorkerConfig } from '@cereworker/config';

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require('../package.json');
export const OFFICIAL_CEREBELLUM_IMAGE = 'cereworker/cerebellum';
export const OFFICIAL_CEREBELLUM_GPU_ALIAS = `${OFFICIAL_CEREBELLUM_IMAGE}:gpu`;

export interface ResolvedCerebellumModel {
  hostModelsPath: string;
  modelPath: string;
  usingPrefetchedCache: boolean;
}

export interface ResolvedCerebellumDockerImage {
  configuredImage: string;
  configuredStatusImage: string;
  expectedImage: string | null;
  runtimeImage: string;
  localAlignmentImages: string[];
  repo: string;
  variant: 'cpu' | 'gpu';
  officialImage: boolean;
  aliasImage: boolean;
  customImage: boolean;
}

function splitImageReference(image: string): { repo: string; tag?: string } {
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return {
      repo: image.slice(0, lastColon),
      tag: image.slice(lastColon + 1),
    };
  }
  return { repo: image };
}

export function getCurrentCereWorkerVersion(): string {
  return CLI_VERSION;
}

export function getOfficialCerebellumImage(
  variant: 'cpu' | 'gpu',
  options?: { version?: string },
): string {
  const version = options?.version ?? getCurrentCereWorkerVersion();
  return `${OFFICIAL_CEREBELLUM_IMAGE}:${variant === 'gpu' ? `${version}-gpu` : version}`;
}

export function resolveCerebellumDockerImage(
  config: Pick<CereWorkerConfig, 'cerebellum'>,
  options?: { version?: string },
): ResolvedCerebellumDockerImage {
  const configuredImage = config.cerebellum.docker.image;
  const version = options?.version ?? getCurrentCereWorkerVersion();
  const { repo, tag } = splitImageReference(configuredImage);
  const officialImage = repo === OFFICIAL_CEREBELLUM_IMAGE;
  const variant: 'cpu' | 'gpu' = tag === 'gpu' || tag?.endsWith('-gpu') ? 'gpu' : 'cpu';
  const aliasImage = officialImage && (!tag || tag === 'latest' || tag === 'gpu');
  const expectedImage = officialImage ? getOfficialCerebellumImage(variant, { version }) : null;
  const configuredStatusImage = !tag && officialImage
    ? `${configuredImage}:latest`
    : configuredImage;
  const runtimeImage = aliasImage ? (expectedImage ?? configuredImage) : configuredImage;
  const localAlignmentImages = officialImage
    ? [...new Set(aliasImage ? [runtimeImage, configuredStatusImage] : [configuredImage])]
    : [configuredImage];

  return {
    configuredImage,
    configuredStatusImage,
    expectedImage,
    runtimeImage,
    localAlignmentImages,
    repo,
    variant,
    officialImage,
    aliasImage,
    customImage: !officialImage,
  };
}

function findSnapshotHash(repoCacheDir: string): string | null {
  const refPath = join(repoCacheDir, 'refs', 'main');
  if (existsSync(refPath)) {
    const ref = readFileSync(refPath, 'utf-8').trim();
    if (ref) return ref;
  }

  const snapshotsDir = join(repoCacheDir, 'snapshots');
  if (!existsSync(snapshotsDir)) return null;

  const entries = readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return entries.at(-1) ?? null;
}

export function resolveCerebellumDockerModel(
  config: Pick<CereWorkerConfig, 'cerebellum'>,
  options?: {
    homeDir?: string;
    pathExists?: (path: string) => boolean;
  },
): ResolvedCerebellumModel {
  const pathExists = options?.pathExists ?? existsSync;
  const homeDir = options?.homeDir ?? homedir();
  const hostModelsPath = config.cerebellum.docker.modelsPath.replace(/^~/, homeDir);
  const fallbackModelPath = config.cerebellum.model.path ?? config.cerebellum.model.id;

  if (config.cerebellum.model.source !== 'huggingface' || !config.cerebellum.model.id) {
    return {
      hostModelsPath,
      modelPath: fallbackModelPath,
      usingPrefetchedCache: false,
    };
  }

  const repoKey = `models--${config.cerebellum.model.id.replace(/\//g, '--')}`;
  const repoCacheDirs = [
    join(hostModelsPath, 'hub', repoKey),
    join(hostModelsPath, repoKey),
  ];

  for (const repoCacheDir of repoCacheDirs) {
    if (!pathExists(repoCacheDir)) continue;
    const snapshotHash = findSnapshotHash(repoCacheDir);
    if (!snapshotHash) continue;

    const relativeParts = repoCacheDir
      .slice(hostModelsPath.length)
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean);

    return {
      hostModelsPath,
      modelPath: [
        '/root/.cache/huggingface',
        ...relativeParts,
        'snapshots',
        snapshotHash,
      ].join('/'),
      usingPrefetchedCache: true,
    };
  }

  return {
    hostModelsPath,
    modelPath: fallbackModelPath,
    usingPrefetchedCache: false,
  };
}

export function buildCerebellumComposeEnv(
  config: Pick<CereWorkerConfig, 'cerebellum'>,
  options?: {
    homeDir?: string;
    pathExists?: (path: string) => boolean;
  },
): Record<string, string> {
  const pathExists = options?.pathExists ?? existsSync;
  const resolvedModel = resolveCerebellumDockerModel(config, options);
  const env: Record<string, string> = {
    MODEL_PATH: resolvedModel.modelPath,
    HEARTBEAT_INTERVAL: String(config.cerebellum.heartbeatInterval),
  };

  if (pathExists(resolvedModel.hostModelsPath)) {
    env.CEREWORKER_MODELS = resolvedModel.hostModelsPath;
  }

  return env;
}

export function buildCerebellumComposeCommand(
  composeFile: string,
  composeEnv: Record<string, string>,
  useSudo: boolean,
): {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
} {
  if (useSudo) {
    return {
      command: 'sudo',
      args: [
        'env',
        ...Object.entries(composeEnv).map(([key, value]) => `${key}=${value}`),
        'docker',
        'compose',
        '-f',
        composeFile,
        'up',
        '-d',
        'cerebellum',
      ],
    };
  }

  return {
    command: 'docker',
    args: ['compose', '-f', composeFile, 'up', '-d', 'cerebellum'],
    env: {
      ...process.env,
      ...composeEnv,
    },
  };
}
