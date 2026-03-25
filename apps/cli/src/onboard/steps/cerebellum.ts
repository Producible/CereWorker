import { execSync, spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { totalmem, homedir } from 'node:os';
import { join } from 'node:path';
import { clack, guardCancel } from '../prompter.js';

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
  dockerImage?: string;
}

interface HardwareInfo {
  totalRamGB: number;
  hasDocker: boolean;
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

  return { totalRamGB, hasDocker, hasGpu, gpuVramGB, gpuName };
}

export async function cerebellumStep(): Promise<CerebellumResult> {
  // Detect hardware
  const hw = detectHardware();

  const hwSummary = [
    `RAM: ${hw.totalRamGB} GB`,
    hw.hasGpu ? `GPU: ${hw.gpuName} (${hw.gpuVramGB} GB VRAM)` : 'GPU: not detected',
    hw.hasDocker ? 'Docker: installed' : 'Docker: not found',
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
      clack.log.info('Installing Docker...');
      try {
        const platform = process.platform;
        if (platform === 'darwin') {
          execSync('brew install --cask docker', { stdio: 'inherit' });
        } else {
          execSync('curl -fsSL https://get.docker.com | sudo sh', { stdio: 'inherit' });
        }
        // Re-check after install
        try {
          execSync('which docker', { stdio: 'pipe' });
          hw.hasDocker = true;
          clack.log.success('Docker installed successfully.');

          // Start the Docker service
          try {
            execSync('sudo systemctl start docker', { stdio: 'pipe', timeout: 15_000 });
            execSync('sudo systemctl enable docker', { stdio: 'pipe', timeout: 10_000 });
            clack.log.success('Docker service started and enabled on boot.');
          } catch {
            clack.log.warn('Could not start Docker service. Run: sudo systemctl start docker');
          }
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

  // Build Cerebellum Docker image
  if (hw.hasDocker) {
    // Detect if docker requires sudo (user not in docker group / rootless not configured)
    let dockerPrefix = '';
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
    } catch {
      dockerPrefix = 'sudo ';
    }

    const imageTag = hw.hasGpu ? 'gpu' : 'latest';
    const fullImage = `cereworker/cerebellum:${imageTag}`;
    clack.log.info(`Selected image: ${fullImage}${hw.hasGpu ? ' (GPU detected)' : ' (CPU)'}`);

    let hasImage = false;
    try {
      const out = execSync(`${dockerPrefix}docker images -q ${fullImage}`, { stdio: 'pipe' }).toString().trim();
      hasImage = !!out;
    } catch {}

    if (!hasImage) {
      const pullImage = guardCancel(
        await clack.confirm({
          message: `Download Cerebellum Docker image (${imageTag}) now?`,
          initialValue: true,
        }),
      );

      if (pullImage) {
        if (dockerPrefix) {
          clack.log.info('Docker requires elevated privileges. You may be prompted for your password.');
        }
        clack.log.info(`Pulling ${fullImage}...`);
        try {
          // Use stdio: 'inherit' so Docker shows its own native progress bar
          const args = dockerPrefix
            ? ['docker', 'pull', fullImage]
            : ['pull', fullImage];
          const cmd = dockerPrefix ? 'sudo' : 'docker';
          const code = await new Promise<number | null>((resolve, reject) => {
            const proc = nodeSpawn(cmd, args, { stdio: 'inherit' });
            const timer = setTimeout(() => { proc.kill(); reject(new Error('Pull timed out')); }, 3_600_000);
            proc.on('close', (c) => { clearTimeout(timer); resolve(c); });
            proc.on('error', (err) => { clearTimeout(timer); reject(err); });
          });
          if (code === 0) {
            clack.log.success('Cerebellum image ready.');
          } else {
            clack.log.warn(`docker pull exited with code ${code}. You can retry with "cereworker onboard".`);
          }
        } catch {
          // Pull may have succeeded despite error — check before reporting failure
          try {
            const pulled = execSync(`${dockerPrefix}docker images -q ${fullImage}`, { stdio: 'pipe' }).toString().trim();
            if (pulled) {
              clack.log.success('Cerebellum image ready.');
            } else {
              clack.log.warn('Failed to pull image. You can retry with "cereworker onboard".');
            }
          } catch {
            clack.log.warn('Failed to pull image. You can retry with "cereworker onboard".');
          }
        }
      } else {
        clack.log.warn('Skipped. Run "cereworker onboard" later to download the image.');
      }
    } else {
      clack.log.info('Cerebellum Docker image already exists.');
    }

    // Pre-download model weights on host so container starts instantly
    if (model?.source === 'huggingface' && model.id) {
      const modelsDir = join(homedir(), '.cereworker', 'models');
      mkdirSync(modelsDir, { recursive: true });

      const downloadScript = `
import sys, os
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1])
`.trim();

      clack.log.info(`Downloading ${model.id} model weights...`);
      try {
        const args = dockerPrefix
          ? ['docker', 'run', '--rm', '-v', `${modelsDir}:/root/.cache/huggingface`, fullImage, 'python', '-c', downloadScript, model.id!]
          : ['docker', 'run', '--rm', '-v', `${modelsDir}:/root/.cache/huggingface`, fullImage, 'python', '-c', downloadScript, model.id!];
        const cmd = dockerPrefix ? 'sudo' : args.shift()!;
        // Use stdio: 'inherit' so tqdm shows native progress bars
        const code = await new Promise<number | null>((resolve, reject) => {
          const proc = nodeSpawn(cmd, args, { stdio: 'inherit' });
          const timer = setTimeout(() => { proc.kill(); reject(new Error('Download timed out')); }, 600_000);
          proc.on('close', (c) => { clearTimeout(timer); resolve(c); });
          proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        });
        if (code === 0) {
          clack.log.success('Model weights downloaded.');
        } else {
          clack.log.warn(`Model download exited with code ${code}. It will be downloaded on first startup.`);
        }
      } catch (err) {
        clack.log.warn('Model download failed. It will be downloaded on first startup.');
        const msg = err instanceof Error ? err.message : String(err);
        if (msg) clack.log.warn(msg);
      }
    }
  }

  const dockerAutoStart = guardCancel(
    await clack.confirm({
      message: 'Auto-start Cerebellum Docker container?',
      initialValue: hw.hasDocker,
    }),
  );

  const dockerImage = hw.hasGpu ? 'cereworker/cerebellum:gpu' : 'cereworker/cerebellum:latest';

  return { enabled: true, model, finetune, dockerAutoStart, dockerImage };
}
