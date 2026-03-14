import { clack, guardCancel } from '../prompter.js';

export interface GatewayResult {
  mode: 'standalone' | 'gateway' | 'node';
  port?: number;
  token?: string | { envRef: string };
  gatewayUrl?: string;
  nodeId?: string;
  capabilities?: string[];
}

async function collectToken(): Promise<string | { envRef: string } | undefined> {
  const envValue = process.env.GATEWAY_TOKEN;
  if (envValue) {
    const useEnv = guardCancel(
      await clack.confirm({
        message: 'Found GATEWAY_TOKEN in environment. Use it?',
        initialValue: true,
      }),
    );
    if (useEnv) return { envRef: 'GATEWAY_TOKEN' };
  }

  const mode = guardCancel(
    await clack.select({
      message: 'Shared authentication token',
      options: [
        { value: 'env', label: 'Reference env var (${GATEWAY_TOKEN})', hint: 'recommended' },
        { value: 'plain', label: 'Store directly in config' },
        { value: 'none', label: 'No token (not recommended)' },
      ],
    }),
  ) as string;

  if (mode === 'none') return undefined;

  if (mode === 'env') {
    if (!envValue) {
      clack.log.warn('Set GATEWAY_TOKEN in your shell profile before running CereWorker.');
    }
    return { envRef: 'GATEWAY_TOKEN' };
  }

  const value = guardCancel(
    await clack.text({
      message: 'Enter shared token',
      validate: (v) => (v.length > 0 ? undefined : 'Token is required'),
    }),
  ) as string;
  return value;
}

export async function gatewayStep(): Promise<GatewayResult> {
  const mode = guardCancel(
    await clack.select({
      message: 'Gateway mode',
      options: [
        { value: 'standalone', label: 'Standalone (single instance)', hint: 'default' },
        { value: 'gateway', label: 'Gateway hub (accept connections from nodes)' },
        { value: 'node', label: 'Node (connect to a gateway hub)' },
      ],
    }),
  ) as 'standalone' | 'gateway' | 'node';

  if (mode === 'standalone') {
    return { mode };
  }

  if (mode === 'gateway') {
    const portStr = guardCancel(
      await clack.text({
        message: 'Gateway port',
        initialValue: '18800',
        validate: (v) => {
          const n = Number(v);
          if (isNaN(n) || n < 1 || n > 65535) return 'Must be a valid port (1-65535)';
          return undefined;
        },
      }),
    ) as string;

    const token = await collectToken();

    return {
      mode,
      port: Number(portStr),
      token,
    };
  }

  // Node mode
  const gatewayUrl = guardCancel(
    await clack.text({
      message: 'Gateway URL (e.g., ws://gateway-host:18800)',
      validate: (v) => (v.length > 0 ? undefined : 'Gateway URL is required'),
    }),
  ) as string;

  const nodeId = guardCancel(
    await clack.text({
      message: 'Node ID (unique name for this instance)',
      validate: (v) => (v.length > 0 ? undefined : 'Node ID is required'),
    }),
  ) as string;

  const token = await collectToken();

  const capsStr = guardCancel(
    await clack.text({
      message: 'Capabilities to expose (comma-separated, e.g., shell,file)',
      initialValue: '',
      placeholder: 'leave empty to expose all tools',
    }),
  ) as string;

  const capabilities = capsStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    mode,
    gatewayUrl,
    nodeId,
    token,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
  };
}
