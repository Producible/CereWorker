import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentCereWorkerVersion } from './cerebellum-docker.js';

const srcDir = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(srcDir, '../dist/index.js');
const hasBuiltCli = existsSync(cliEntry);
const hasScript = spawnSync('which', ['script'], { stdio: 'pipe' }).status === 0;
const describeBuilt = hasBuiltCli ? describe : describe.skip;

function makeTempHome(configYaml?: string): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'cereworker-cli-'));
  mkdirSync(join(homeDir, '.cereworker'), { recursive: true });
  if (configYaml !== undefined) {
    writeFileSync(join(homeDir, '.cereworker', 'config.yaml'), configYaml, 'utf-8');
  }
  return homeDir;
}

function makeEnv(homeDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ...extra,
  };
}

async function runCli(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    nodeArgs?: string[];
    cwd?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [...(options.nodeArgs ?? []), cliEntry, ...args],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${options.timeoutMs ?? 20_000}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, options.timeoutMs ?? 20_000);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

async function runCliWithPty(
  args: string[],
  input: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
    inputDelayMs?: number;
  } = {},
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    'script',
    ['-q', '-e', '-f', '-c', `${process.execPath} ${cliEntry} ${args.join(' ')}`, '/dev/null'],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const writer = (async () => {
    for (const chunk of input) {
      await new Promise((resolve) => setTimeout(resolve, options.inputDelayMs ?? 200));
      child.stdin.write(chunk);
    }
    child.stdin.end();
  })();

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PTY CLI timed out after ${options.timeoutMs ?? 30_000}ms\nOUTPUT:\n${output}`));
    }, options.timeoutMs ?? 30_000);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', async (code) => {
      clearTimeout(timeout);
      await writer;
      resolve({ code, output });
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`health check timed out on port ${port}`);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createServer } from 'node:http';
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') process.exit(1);
        console.log(address.port);
        server.close(() => process.exit(0));
      });
    `], { encoding: 'utf-8' });
    if (server.status !== 0) {
      reject(new Error(server.stderr || 'failed to allocate port'));
      return;
    }
    resolve(Number(server.stdout.trim()));
  });
}

function writeFakeDocker(dir: string, logPath: string): string {
  const dockerPath = join(dir, 'docker');
  writeFileSync(dockerPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
cmd="\${1:-}"
case "$cmd" in
  info)
    exit 0
    ;;
  images)
    shift
    target="\${1:-}"
    shift || true
    rest="$*"
    if [[ "$rest" == *'{{.Digest}}'* ]]; then
      echo "sha256:abc123"
      exit 0
    fi
    if [[ "$rest" == *'-q'* ]]; then
      echo "img123"
      exit 0
    fi
    if [[ "$rest" == *'table {{.Repository}}:{{.Tag}}'* ]]; then
      echo -e "REPOSITORY:TAG\\tIMAGE ID\\tSIZE\\tCREATED"
      echo -e "\${target}:gpu\\timg123\\t1.2GB\\t2 hours ago"
      exit 0
    fi
    ;;
  image)
    shift
    if [[ "\${1:-}" == "inspect" ]]; then
      target="\${2:-}"
      if [[ "\${target}" == cereworker/cerebellum:* ]]; then
        echo '["cereworker/cerebellum@sha256:abc123"]'
        exit 0
      fi
      if [[ "\${target}" == "registry.example/cerebellum:gpu" ]]; then
        echo '["registry.example/cerebellum@sha256:abc123"]'
        exit 0
      fi
    fi
    ;;
  ps)
    shift
    rest="$*"
    if [[ "$rest" == *'-aq -f name=cereworker-cerebellum'* ]]; then
      echo "container123"
      exit 0
    fi
    if [[ "$rest" == *'--format table {{.Image}}'* ]]; then
      echo -e "IMAGE\\tSTATUS\\tPORTS"
      echo -e "registry.example/cerebellum:gpu\\tUp 2 minutes\\t0.0.0.0:50051->50051/tcp"
      exit 0
    fi
    exit 0
    ;;
  manifest)
    shift
    if [[ "\${1:-}" == "inspect" ]]; then
      shift
      if [[ "\${1:-}" == "--verbose" ]]; then shift; fi
      echo '{"Descriptor":{"digest":"sha256:abc123"}}'
      exit 0
    fi
    ;;
  pull)
    echo "Downloaded newer image for \${1:-}"
    exit 0
    ;;
  rm)
    shift
    if [[ "\${1:-}" == "-f" ]]; then
      shift || true
    fi
    echo "\${1:-cereworker-cerebellum}"
    exit 0
    ;;
esac
exit 0
`, { mode: 0o755 });
  return dockerPath;
}

describeBuilt('CLI smoke', () => {
  const tempHomes: string[] = [];

  afterEach(() => {
    for (const homeDir of tempHomes.splice(0)) {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('returns quickly for -v even when the registry check is slow', async () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);
    const hookPath = join(homeDir, 'slow-fetch-hook.mjs');
    writeFileSync(hookPath, `
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'https://registry.npmjs.org/@cereworker/cli/latest') {
          return await new Promise((resolve) => {
            setTimeout(() => resolve(new Response(JSON.stringify({ version: '99.0.0' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })), 10_000);
          });
        }
        return await originalFetch(input, init);
      };
    `, 'utf-8');

    const result = await runCli(['-v'], {
      env: makeEnv(homeDir),
      nodeArgs: ['--import', hookPath],
      timeoutMs: 10_000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('26.');
    expect(result.stdout).not.toContain('Update available:');
    // 500ms race timeout + process startup should be well under 5s.
    // If this exceeds 5s, the race timeout is not working and -v is blocking on the fetch.
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('uses the configured image for images and upgrade commands', async () => {
    const homeDir = makeTempHome(`
cerebrum:
  defaultProvider: local
  defaultModel: llama3.3
  providers:
    local:
      baseUrl: http://127.0.0.1:11434
      model: llama3.3
cerebellum:
  enabled: false
  docker:
    image: registry.example/cerebellum:gpu
tools:
  browser:
    enabled: false
`);
    tempHomes.push(homeDir);

    const binDir = join(homeDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const dockerLog = join(homeDir, 'docker.log');
    writeFakeDocker(binDir, dockerLog);
    const env = makeEnv(homeDir, { PATH: `${binDir}:${process.env.PATH ?? ''}` });

    const images = await runCli(['images'], { env });
    expect(images.code).toBe(0);
    expect(images.stdout).toContain('registry.example/cerebellum:gpu');
    expect(images.stdout).toContain('Running container');

    const upgrade = await runCli(['images', 'upgrade'], { env });
    expect(upgrade.code).toBe(0);
    expect(upgrade.stdout).toContain('Pulling registry.example/cerebellum:gpu...');
    expect(upgrade.stdout).toContain('Old container removed');

    const dockerCalls = readFileSync(dockerLog, 'utf-8');
    expect(dockerCalls).toContain('pull registry.example/cerebellum:gpu');
    expect(dockerCalls).not.toContain('cereworker/cerebellum:latest');
  });

  it('aligns official alias images to the current CereWorker version', async () => {
    const version = getCurrentCereWorkerVersion();
    const homeDir = makeTempHome(`
cerebrum:
  defaultProvider: local
  defaultModel: llama3.3
  providers:
    local:
      baseUrl: http://127.0.0.1:11434
      model: llama3.3
cerebellum:
  enabled: false
  docker:
    image: cereworker/cerebellum
tools:
  browser:
    enabled: false
`);
    tempHomes.push(homeDir);

    const binDir = join(homeDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const dockerLog = join(homeDir, 'docker.log');
    writeFakeDocker(binDir, dockerLog);
    const env = makeEnv(homeDir, { PATH: `${binDir}:${process.env.PATH ?? ''}` });

    const images = await runCli(['images'], { env });
    expect(images.code).toBe(0);
    expect(images.stdout).toContain('Configured image: cereworker/cerebellum');
    expect(images.stdout).toContain(`Expected image for CereWorker ${version}: cereworker/cerebellum:${version}`);
    expect(images.stdout).toContain(`Alignment: aligned with CereWorker ${version}.`);

    const upgrade = await runCli(['images', 'upgrade'], { env });
    expect(upgrade.code).toBe(0);
    expect(upgrade.stdout).toContain(`Pulling cereworker/cerebellum:${version}...`);
    expect(upgrade.stdout).toContain(`Aligned with CereWorker ${version} via cereworker/cerebellum:${version}`);

    const dockerCalls = readFileSync(dockerLog, 'utf-8');
    expect(dockerCalls).toContain(`pull cereworker/cerebellum:${version}`);
    expect(dockerCalls).not.toContain('pull cereworker/cerebellum:latest');
  });

  it('starts headless mode and serves health checks from a temp config', async () => {
    const port = await getFreePort();
    const homeDir = makeTempHome(`
cerebrum:
  defaultProvider: local
  defaultModel: llama3.3
  providers:
    local:
      baseUrl: http://127.0.0.1:11434
      model: llama3.3
cerebellum:
  enabled: false
tools:
  shell:
    enabled: false
  fileOps:
    enabled: false
  http:
    enabled: false
  web:
    enabled: false
  browser:
    enabled: false
hippocampus:
  enabled: false
proactive:
  enabled: false
subAgents:
  enabled: false
gateway:
  mode: standalone
  port: ${port}
`);
    tempHomes.push(homeDir);

    const child = spawn(process.execPath, [cliEntry, 'serve'], {
      env: makeEnv(homeDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    try {
      await waitForHealth(port);
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = await response.json() as { healthy?: boolean; mode?: string };
      expect(body.healthy).toBe(true);
      expect(body.mode).toBe('standalone');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('close', resolve));
    }

    expect(stderr).toContain('CereWorker service ready');
  });

  it.skipIf(!hasScript)('reruns onboarding and keeps existing sections without dropping env refs', async () => {
    const homeDir = makeTempHome(`
cerebrum:
  defaultProvider: openai
  defaultModel: gpt-4o
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY}
cerebellum:
  enabled: false
channels:
  dmPolicy: open
  discord:
    enabled: true
    token: \${DISCORD_TOKEN}
gateway:
  mode: standalone
`);
    tempHomes.push(homeDir);

    const result = await runCliWithPty(
      ['onboard'],
      ['\n', '\n', '\n', '\n', '\n', '\n', '\n', '\n'],
      {
        env: makeEnv(homeDir),
        timeoutMs: 30_000,
        inputDelayMs: 250,
      },
    );

    expect(result.code).toBe(0);
    const configPath = join(homeDir, '.cereworker', 'config.yaml');
    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain('${OPENAI_API_KEY}');
    expect(config).toContain('${DISCORD_TOKEN}');
  });
});
