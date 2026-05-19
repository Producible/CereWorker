import { execSync } from 'node:child_process';
import { loadConfig } from '@producible/cereworker-config';
import {
  getCurrentCereWorkerVersion,
  resolveCerebellumDockerImage,
} from './cerebellum-docker.js';

function inspectRemoteDigest(dockerCmd: string, image: string): string | null {
  try {
    const manifest = execSync(`${dockerCmd} manifest inspect --verbose ${image}`, {
      stdio: 'pipe',
      timeout: 15_000,
    }).toString().trim();
    if (!manifest) return null;
    const parsed = JSON.parse(manifest) as {
      Descriptor?: { digest?: string };
      digest?: string;
      config?: { digest?: string };
    };
    return parsed.Descriptor?.digest ?? parsed.digest ?? parsed.config?.digest ?? null;
  } catch {
    return null;
  }
}

function inspectLocalDigest(dockerCmd: string, image: string): string | null {
  try {
    const output = execSync(
      `${dockerCmd} image inspect ${image} --format "{{json .RepoDigests}}"`,
      { stdio: 'pipe' },
    ).toString().trim();
    if (!output) return null;
    const repoDigests = JSON.parse(output) as string[];
    const digest = repoDigests
      .map((entry) => entry.split('@')[1]?.trim() ?? '')
      .find((entry) => entry.length > 0);
    return digest ?? null;
  } catch {
    return null;
  }
}

export async function runUpgrade(): Promise<void> {
  const config = loadConfig();
  const image = resolveCerebellumDockerImage(config);
  const currentVersion = getCurrentCereWorkerVersion();
  const targetImage = image.runtimeImage;

  // Detect docker binary
  let dockerBin = '';
  try {
    dockerBin = execSync('which docker', { stdio: 'pipe' }).toString().trim();
  } catch {
    for (const c of ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker']) {
      try {
        execSync(`test -x ${c}`, { stdio: 'pipe' });
        dockerBin = c;
        break;
      } catch {}
    }
  }

  if (!dockerBin) {
    console.error('Docker is not installed.');
    process.exit(1);
  }

  // Detect sudo requirement
  let prefix = '';
  try {
    execSync(`${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
  } catch {
    try {
      execSync(`sudo -n ${dockerBin} info`, { stdio: 'pipe', timeout: 10_000 });
      prefix = 'sudo ';
    } catch {
      console.error('Docker permission denied. Run: sudo usermod -aG docker $USER && newgrp docker');
      process.exit(1);
    }
  }

  // Pull latest image
  console.log(`Pulling ${targetImage}...`);
  try {
    execSync(`${prefix}${dockerBin} pull ${targetImage}`, { stdio: 'inherit', timeout: 3_600_000 });
  } catch {
    console.error(`Failed to pull ${targetImage}`);
    process.exit(1);
  }

  if (image.aliasImage && image.expectedImage) {
    const localDigest = inspectLocalDigest(`${prefix}${dockerBin}`, targetImage);
    const expectedDigest = inspectRemoteDigest(`${prefix}${dockerBin}`, image.expectedImage);
    if (!localDigest || !expectedDigest || localDigest !== expectedDigest) {
      console.error(`Pulled image is not aligned with CereWorker ${currentVersion}.`);
      console.error(`Expected ${image.expectedImage}`);
      process.exit(1);
    }
  }

  // Recreate container if it exists
  try {
    const existing = execSync(
      `${prefix}${dockerBin} ps -aq -f name=cereworker-cerebellum`,
      { stdio: 'pipe' },
    ).toString().trim();

    if (existing) {
      console.log('Stopping old container...');
      execSync(`${prefix}${dockerBin} rm -f cereworker-cerebellum`, { stdio: 'pipe' });
      console.log('Old container removed. It will be recreated on next start.');
    }
  } catch {
    // No container to remove — that's fine
  }

  if (image.aliasImage && image.expectedImage) {
    console.log(`Upgrade complete. Aligned with CereWorker ${currentVersion} via ${image.expectedImage}.`);
  } else {
    console.log('Upgrade complete.');
  }
}
