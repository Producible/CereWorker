import { execSync } from 'node:child_process';
import { loadConfig } from '@cereworker/config';

export async function runUpgrade(): Promise<void> {
  const config = loadConfig();
  const image = config.cerebellum.docker.image;

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
  console.log(`Pulling ${image}...`);
  try {
    execSync(`${prefix}${dockerBin} pull ${image}`, { stdio: 'inherit', timeout: 3_600_000 });
  } catch {
    console.error(`Failed to pull ${image}`);
    process.exit(1);
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

  console.log('Upgrade complete.');
}
