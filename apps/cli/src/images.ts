import { execSync } from 'node:child_process';
import { loadConfig } from '@cereworker/config';

export async function runImages(): Promise<void> {
  const config = loadConfig();
  const image = config.cerebellum.docker.image;

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
      `${dockerCmd} images cereworker/cerebellum --format "table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}"`,
      { stdio: 'pipe' },
    ).toString().trim();

    if (!output || output.split('\n').length <= 1) {
      console.log('No Cerebellum images found locally.');
      console.log(`Run "cereworker images upgrade" to pull ${image}.`);
      return;
    }

    console.log('Local Cerebellum images:\n');
    console.log(output);
  } catch {
    console.log('No Cerebellum images found locally.');
    console.log(`Run "cereworker images upgrade" to pull ${image}.`);
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

  // Check remote digest vs local
  try {
    const localDigest = execSync(
      `${dockerCmd} images cereworker/cerebellum:latest --format "{{.Digest}}"`,
      { stdio: 'pipe' },
    ).toString().trim();

    if (localDigest && localDigest !== '<none>') {
      const remoteDigest = execSync(
        `${dockerCmd} manifest inspect cereworker/cerebellum:latest 2>/dev/null | grep -o '"digest": "sha256:[a-f0-9]*"' | head -1`,
        { stdio: 'pipe', timeout: 15_000 },
      ).toString().trim();

      if (remoteDigest && !remoteDigest.includes(localDigest.replace('sha256:', ''))) {
        console.log('\nA newer image may be available. Run "cereworker images upgrade" to update.');
      }
    }
  } catch {
    // Remote check failed — skip silently
  }
}
