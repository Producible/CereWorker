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
        const pullSpinner = clack.spinner();
        pullSpinner.start(`Pulling ${fullImage} from Docker Hub...`);
        try {
          await new Promise<void>((resolve, reject) => {
            const args = dockerPrefix
              ? ['docker', 'pull', '--progress=plain', fullImage]
              : ['pull', '--progress=plain', fullImage];
            const cmd = dockerPrefix ? 'sudo' : 'docker';
            const proc = nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

            const timer = setTimeout(() => {
              proc.kill();
              reject(new Error('Pull timed out'));
            }, 3_600_000);

            // Docker pull writes progress to stdout — parse layer progress
            let layersDone = 0;
            let layersTotal = 0;
            const layerStatus = new Map<string, string>();

            const parseDockerProgress = (data: Buffer) => {
              // Docker pull uses \r for in-place progress updates, split on both \r and \n
              for (const line of data.toString().split(/[\r\n]+/)) {
                // Lines like: "abc123: Downloading [==>   ] 23.4MB/156MB"
                // or: "abc123: Pull complete"
                const match = line.match(/([a-f0-9]+):\s+(.+)/);
                if (match) {
                  const [, id, status] = match;
                  layerStatus.set(id, status.trim());
                  layersTotal = layerStatus.size;
                  layersDone = [...layerStatus.values()].filter(s => s.includes('complete') || s.includes('exists')).length;
                  const dlMatch = status.match(/Downloading.*?(\d+(?:\.\d+)?\s*[kMG]?B)\/(\d+(?:\.\d+)?\s*[kMG]?B)/);
                  if (dlMatch) {
                    pullSpinner.message(`Pulling ${fullImage} — layer ${layersDone}/${layersTotal} (${dlMatch[1].trim()}/${dlMatch[2].trim()})`);
                  } else if (status.includes('Extracting')) {
                    pullSpinner.message(`Pulling ${fullImage} — extracting layer ${layersDone}/${layersTotal}`);
                  } else if (layersDone > 0) {
                    pullSpinner.message(`Pulling ${fullImage} — layer ${layersDone}/${layersTotal}`);
                  }
                }
              }
            };

            proc.stdout.on('data', parseDockerProgress);
            proc.stderr.on('data', parseDockerProgress);

            proc.on('close', (code) => {
              clearTimeout(timer);
              code === 0 ? resolve() : reject(new Error(`docker pull exited with code ${code}`));
            });
            proc.on('error', (err) => { clearTimeout(timer); reject(err); });
          });
          pullSpinner.stop('Cerebellum image ready.');
        } catch {
          pullSpinner.stop();
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

      // Python script that prints structured progress as HuggingFace downloads files.
      // Uses huggingface_hub.snapshot_download with a patched tqdm that emits JSON to stderr.
      const downloadScript = `
import sys, json, os
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
from huggingface_hub import snapshot_download
try:
    from huggingface_hub.utils import tqdm as hf_tqdm
    _orig_tqdm = hf_tqdm.tqdm
    class ProgressTqdm(_orig_tqdm):
        def update(self, n=1):
            super().update(n)
            if self.total and self.total > 1048576:
                pct = self.n / self.total * 100 if self.total else 0
                mb_done = self.n / 1048576
                mb_total = self.total / 1048576
                desc = self.desc or ""
                print(json.dumps({"pct": round(pct, 1), "done_mb": round(mb_done, 1), "total_mb": round(mb_total, 1), "file": desc}), file=sys.stderr, flush=True)
    hf_tqdm.tqdm = ProgressTqdm
except Exception:
    pass
snapshot_download(sys.argv[1])
print("OK", flush=True)
`.trim();

      const spinner = clack.spinner();
      spinner.start(`Downloading ${model.id} model weights...`);

      try {
        await new Promise<void>((resolve, reject) => {
          const args = dockerPrefix
            ? ['docker', 'run', '--rm', '-v', `${modelsDir}:/root/.cache/huggingface`, fullImage, 'python', '-c', downloadScript, model.id!]
            : ['docker', 'run', '--rm', '-v', `${modelsDir}:/root/.cache/huggingface`, fullImage, 'python', '-c', downloadScript, model.id!];
          const cmd = dockerPrefix ? 'sudo' : args.shift()!;
          const proc = nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

          const timer = setTimeout(() => {
            proc.kill();
            reject(new Error('Download timed out after 10 minutes'));
          }, 600_000);

          let stderrTail = '';
          proc.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            // Keep last 2KB of stderr for error reporting
            stderrTail = (stderrTail + text).slice(-2048);
            const lines = text.split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const p = JSON.parse(line) as { pct: number; done_mb: number; total_mb: number; file: string };
                const fileName = p.file ? p.file.replace(/.*\//, '') : '';
                spinner.message(`Downloading ${model.id} — ${fileName} ${p.pct}% (${p.done_mb}/${p.total_mb} MB)`);
              } catch {
                // Non-JSON stderr (tqdm bars, warnings) — ignore
              }
            }
          });

          let stdout = '';
          proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

          proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && stdout.includes('OK')) {
              resolve();
            } else {
              reject(new Error(`exit code ${code}${stderrTail ? '\n' + stderrTail.trim() : ''}`));
            }
          });

          proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        spinner.stop('Model weights downloaded.');
      } catch (err) {
        spinner.stop('Model download failed. It will be downloaded on first startup.', 1);
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
