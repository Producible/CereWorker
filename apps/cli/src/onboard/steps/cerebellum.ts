import { execSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { clack, guardCancel } from '../prompter.js';

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CerebellumResult {
  enabled: boolean;
  model?: {
    source: 'huggingface' | 'local';
    id?: string;
    path?: string;
  };
  finetune?: {
    enabled: boolean;
    method: string;
    schedule: string;
  };
  dockerAutoStart?: boolean;
}

interface HardwareInfo {
  totalRamGB: number;
  hasDocker: boolean;
  hasSqlite: boolean;
  hasGpu: boolean;
  gpuVramGB: number | null;
  gpuName: string | null;
}

function detectHardware(): HardwareInfo {
  const totalRamGB = Math.round(totalmem() / (1024 * 1024 * 1024));

  let hasDocker = false;
  try {
    execSync('which docker', { stdio: 'pipe' });
    hasDocker = true;
  } catch {}

  let hasSqlite = false;
  try {
    // better-sqlite3 is a dependency of @cereworker/core, not cli.
    // Resolve from core's location so pnpm strict mode doesn't block it.
    const corePath = require.resolve('@cereworker/core');
    const coreRequire = createRequire(corePath);
    coreRequire('better-sqlite3');
    hasSqlite = true;
  } catch {}

  let hasGpu = false;
  let gpuVramGB: number | null = null;
  let gpuName: string | null = null;
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
      { stdio: 'pipe' },
    ).toString().trim();

    if (output) {
      const parts = output.split(',').map((s) => s.trim());
      gpuName = parts[0] ?? null;
      const vramMB = parseInt(parts[1] ?? '0', 10);
      if (vramMB > 0) {
        hasGpu = true;
        gpuVramGB = Math.round(vramMB / 1024);
      }
    }
  } catch {}

  return { totalRamGB, hasDocker, hasSqlite, hasGpu, gpuVramGB, gpuName };
}

export async function cerebellumStep(): Promise<CerebellumResult> {
  // Detect hardware
  const hw = detectHardware();

  const hwSummary = [
    `RAM: ${hw.totalRamGB} GB`,
    hw.hasGpu ? `GPU: ${hw.gpuName} (${hw.gpuVramGB} GB VRAM)` : 'GPU: not detected',
    hw.hasDocker ? 'Docker: installed' : 'Docker: not found',
    hw.hasSqlite ? 'SQLite: OK' : 'SQLite: not available',
  ].join('  |  ');

  clack.log.info(`Hardware: ${hwSummary}`);

  // Model selection
  const modelChoice = guardCancel(
    await clack.select({
      message: 'Cerebellum model',
      options: [
        {
          value: 'Qwen/Qwen3-0.6B',
          label: 'Qwen3 0.6B',
          hint: `~1.2 GB, CPU OK, 2 GB RAM min${hw.totalRamGB < 2 ? ' ⚠ low RAM' : ''}`,
        },
        {
          value: 'Qwen/Qwen3-1.7B',
          label: 'Qwen3 1.7B',
          hint: `~3.4 GB, 4 GB RAM min${hw.totalRamGB < 4 ? ' ⚠ low RAM' : ''}`,
        },
        {
          value: 'HuggingFaceTB/SmolLM2-360M-Instruct',
          label: 'SmolLM2 360M',
          hint: '~720 MB, ultra-lightweight, fastest',
        },
        {
          value: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
          label: 'SmolLM2 1.7B',
          hint: `~3.4 GB, good balance${hw.totalRamGB < 4 ? ' ⚠ low RAM' : ''}`,
        },
        {
          value: 'microsoft/Phi-4-mini-instruct',
          label: 'Phi-4 Mini 3.8B',
          hint: `~7.6 GB, best quality${!hw.hasGpu ? ' ⚠ GPU recommended' : ''}`,
        },
        {
          value: '__custom__',
          label: 'Custom local model',
          hint: 'provide a local path',
        },
      ],
    }),
  ) as string;

  let model: CerebellumResult['model'];

  if (modelChoice === '__custom__') {
    const path = guardCancel(
      await clack.text({
        message: 'Path to local model checkpoint',
        validate: (v) => (v.length > 0 ? undefined : 'Path is required'),
      }),
    ) as string;
    model = { source: 'local', path };
  } else {
    model = { source: 'huggingface', id: modelChoice };
  }

  // Fine-tuning
  const finetuneEnabled = guardCancel(
    await clack.confirm({
      message: 'Enable fine-tuning (Instinct)?',
      initialValue: true,
    }),
  );

  let finetune: CerebellumResult['finetune'];

  if (finetuneEnabled) {
    const autoHint = hw.hasGpu
      ? `will use LoRA (GPU detected, ${hw.gpuVramGB} GB VRAM)`
      : `will use QLoRA or CPU full (no GPU detected)`;

    const method = guardCancel(
      await clack.select({
        message: 'Fine-tune method',
        options: [
          { value: 'auto', label: 'Auto', hint: autoHint },
          { value: 'lora', label: 'LoRA', hint: `GPU 4+ GB VRAM${hw.hasGpu && (hw.gpuVramGB ?? 0) >= 4 ? ' ✓' : ' ⚠'}` },
          { value: 'qlora', label: 'QLoRA', hint: `GPU 2+ GB VRAM${hw.hasGpu && (hw.gpuVramGB ?? 0) >= 2 ? ' ✓' : ' ⚠'}` },
          { value: 'full', label: 'Full', hint: `16+ GB RAM or 8+ GB VRAM${hw.totalRamGB >= 16 || (hw.hasGpu && (hw.gpuVramGB ?? 0) >= 8) ? ' ✓' : ' ⚠'}` },
        ],
      }),
    ) as string;

    const schedule = guardCancel(
      await clack.select({
        message: 'Fine-tune schedule',
        options: [
          { value: 'auto', label: 'Auto', hint: 'during idle time' },
          { value: 'hourly', label: 'Hourly' },
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ],
      }),
    ) as string;

    finetune = { enabled: true, method, schedule };
  } else {
    finetune = { enabled: false, method: 'auto', schedule: 'auto' };
  }

  // Docker
  if (!hw.hasDocker) {
    const installDocker = guardCancel(
      await clack.confirm({
        message: 'Docker not found. Install Docker now?',
        initialValue: true,
      }),
    );

    if (installDocker) {
      const setupScript = resolve(__dirname, '..', '..', '..', 'scripts', 'setup.sh');
      clack.log.info('Installing Docker...');
      try {
        execSync(`bash "${setupScript}" --docker`, { stdio: 'inherit' });
        // Re-check after install
        try {
          execSync('which docker', { stdio: 'pipe' });
          hw.hasDocker = true;
          clack.log.success('Docker installed successfully.');
        } catch {
          clack.log.warn('Docker was installed but may require a re-login to work.');
        }
      } catch {
        clack.log.warn('Docker installation failed. Install it manually to use the Cerebellum container.');
      }
    } else {
      clack.log.warn('Skipped. Install Docker manually to use the Cerebellum container.');
    }
  }

  // SQLite native module check
  if (!hw.hasSqlite) {
    clack.log.warn('SQLite native module (better-sqlite3) is not available.\n  Conversation history and pairing authorization require it.');

    const installBuildTools = guardCancel(
      await clack.confirm({
        message: 'Install build tools and rebuild SQLite module?',
        initialValue: true,
      }),
    );

    if (installBuildTools) {
      const setupScript = resolve(__dirname, '..', '..', '..', 'scripts', 'setup.sh');
      clack.log.info('Installing build tools...');
      try {
        execSync(`bash "${setupScript}" --build-tools`, { stdio: 'inherit' });
        clack.log.info('Installing SQLite native module...');

        // better-sqlite3 is an optionalDependency of @cereworker/core.
        // If build tools were missing during initial install, npm skips it entirely
        // (no files on disk). We need to install it, not just rebuild.
        let corePkgDir: string | null = null;
        try {
          const corePath = require.resolve('@cereworker/core');
          let dir = dirname(corePath);
          for (let i = 0; i < 10; i++) {
            try {
              require('node:fs').accessSync(join(dir, 'package.json'));
              corePkgDir = dir;
              break;
            } catch { dir = dirname(dir); }
          }
        } catch {}

        if (corePkgDir) {
          execSync(`cd "${corePkgDir}" && npm install better-sqlite3`, { stdio: 'inherit', timeout: 120_000 });
        } else {
          // Fallback: reinstall CLI package (triggers optional dep install with build tools now present)
          execSync('npm install -g @cereworker/cli', { stdio: 'inherit', timeout: 120_000 });
        }

        // Re-check via child process (Node caches failed requires in the current process)
        try {
          const corePath = require.resolve('@cereworker/core');
          execSync(`node -e "const {createRequire}=require('module'); createRequire('${corePath}')('better-sqlite3')"`, { stdio: 'pipe' });
          hw.hasSqlite = true;
          clack.log.success('SQLite module rebuilt successfully.');
        } catch {
          clack.log.warn('Rebuild completed but module still not loadable. Conversation history will use JSON fallback.');
        }
      } catch {
        clack.log.warn('Build tools installation failed. Conversation history will use JSON fallback.');
      }
    } else {
      clack.log.warn('Skipped. You can run "cereworker setup --build-tools" later.');
    }
  }

  // Build Cerebellum Docker image
  if (hw.hasDocker) {
    // Detect if docker requires sudo (user not in docker group / rootless not configured)
    let dockerPrefix = '';
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
    } catch {
      dockerPrefix = 'sudo ';
    }

    let hasImage = false;
    try {
      const out = execSync(`${dockerPrefix}docker images -q cereworker-cerebellum:latest`, { stdio: 'pipe' }).toString().trim();
      hasImage = !!out;
    } catch {}

    if (!hasImage) {
      const pullImage = guardCancel(
        await clack.confirm({
          message: 'Download Cerebellum Docker image now?',
          initialValue: true,
        }),
      );

      if (pullImage) {
        if (dockerPrefix) {
          clack.log.info('Docker requires elevated privileges. You may be prompted for your password.');
        }
        try {
          clack.log.info('Pulling Cerebellum image from Docker Hub...');
          execSync(
            `${dockerPrefix}docker pull cereworker/cerebellum:latest`,
            { stdio: 'inherit', timeout: 300_000 },
          );
          execSync(
            `${dockerPrefix}docker tag cereworker/cerebellum:latest cereworker-cerebellum:latest`,
            { stdio: 'pipe' },
          );
          clack.log.success('Cerebellum image ready.');
        } catch {
          clack.log.warn('Failed to pull image. You can retry with "cereworker onboard".');
        }
      } else {
        clack.log.warn('Skipped. Run "cereworker onboard" later to download the image.');
      }
    } else {
      clack.log.info('Cerebellum Docker image already exists.');
    }
  }

  const dockerAutoStart = guardCancel(
    await clack.confirm({
      message: 'Auto-start Cerebellum Docker container?',
      initialValue: hw.hasDocker,
    }),
  );

  return { enabled: true, model, finetune, dockerAutoStart };
}
