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

export async function runImages(): Promise<void> {
  const config = loadConfig();
  const image = resolveCerebellumDockerImage(config);
  const currentVersion = getCurrentCereWorkerVersion();

  // Detect docker
  let dockerCmd = 'docker';
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
  } catch {
    try {
      execSync('sudo -n docker info', { stdio: 'pipe', timeout: 10_000 });
      dockerCmd = 'sudo docker';
    } catch {
      console.error('Docker is not available.');
      process.exit(1);
    }
  }

  // List local images
  try {
    const output = execSync(
      `${dockerCmd} images ${image.repo} --format "table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}"`,
      { stdio: 'pipe' },
    ).toString().trim();

    if (!output || output.split('\n').length <= 1) {
      console.log('No Cerebellum images found locally.');
      console.log(`Run "cereworker images upgrade" to pull ${image.runtimeImage}.`);
      return;
    }

    console.log('Local Cerebellum images:\n');
    console.log(output);
  } catch {
    console.log('No Cerebellum images found locally.');
    console.log(`Run "cereworker images upgrade" to pull ${image.runtimeImage}.`);
    return;
  }

  // Show running container info
  try {
    const container = execSync(
      `${dockerCmd} ps -f name=cereworker-cerebellum --format "table {{.Image}}\t{{.Status}}\t{{.Ports}}"`,
      { stdio: 'pipe' },
    ).toString().trim();

    if (container && container.split('\n').length > 1) {
      console.log('\nRunning container:\n');
      console.log(container);
    } else {
      console.log('\nNo running Cerebellum container.');
    }
  } catch {
    // ignore
  }

  console.log(`\nConfigured image: ${image.configuredImage}`);
  if (image.customImage || !image.expectedImage) {
    console.log('Alignment: custom image (version alignment unmanaged).');
    return;
  }

  console.log(`Expected image for CereWorker ${currentVersion}: ${image.expectedImage}`);

  const localDigest = image.localAlignmentImages
    .map((candidate) => inspectLocalDigest(dockerCmd, candidate))
    .find((digest) => Boolean(digest)) ?? null;
  const expectedDigest = inspectRemoteDigest(dockerCmd, image.expectedImage);

  if (localDigest && expectedDigest) {
    if (localDigest === expectedDigest) {
      console.log(`Alignment: aligned with CereWorker ${currentVersion}.`);
    } else {
      console.log(`Alignment: not aligned; expected ${image.expectedImage}.`);
      console.log('Run "cereworker images upgrade" to pull the matching image version.');
    }
    return;
  }

  console.log(`Alignment: unable to verify; expected ${image.expectedImage}.`);
}
