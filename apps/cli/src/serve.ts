import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { configureLogger, createLogger } from '@cereworker/core';
import type { CereWorkerConfig } from '@cereworker/config';
import { createService } from './service.js';
import type { GatewayHandles } from './service.js';

const log = createLogger('serve');

export async function runHeadlessService(config: CereWorkerConfig): Promise<void> {
  const startTime = Date.now();

  // In headless mode, log all levels to stderr (captured by journalctl/systemd)
  const logFile = config.logging.file || `${homedir()}/.cereworker/cereworker.log`;
  configureLogger({
    level: config.logging.level as 'debug' | 'info' | 'warn' | 'error',
    file: logFile,
    stderr: true,
  });

  const service = createService(config);

  // Start cerebellum
  if (config.cerebellum.enabled) {
    const result = await service.startCerebellum();
    log.info('Cerebellum', { ok: result.ok, reason: result.ok ? undefined : result.reason });
  }

  // Start channels
  const channelCount = await service.startChannels();

  // Start gateway/node
  const handles: GatewayHandles = await service.startGateway();

  // Start health HTTP server
  const mode = config.gateway.mode;
  // Gateway mode: WS server on gateway.port, health on gateway.port + 1
  // Node/standalone: health on gateway.port (no WS server using that port)
  const healthPort = mode === 'gateway' ? config.gateway.port + 1 : config.gateway.port;

  const healthServer = createHealthServer(config, handles, startTime);
  await new Promise<void>((resolve, reject) => {
    healthServer.on('error', reject);
    healthServer.listen(healthPort, () => {
      log.info('Health server listening', { port: healthPort });
      resolve();
    });
  });

  // Graceful shutdown
  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal });

    await new Promise<void>((resolve) => {
      healthServer.close(() => resolve());
    });
    await service.shutdown();
    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { error: String(reason) });
  });

  log.info('CereWorker service ready', {
    mode,
    healthPort,
    channels: channelCount,
    nodeId: config.gateway.nodeId,
  });
}

function createHealthServer(
  config: CereWorkerConfig,
  handles: GatewayHandles,
  startTime: number,
): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const mode = config.gateway.mode;
      const body: Record<string, unknown> = {
        healthy: true,
        mode,
        uptime: Math.round((Date.now() - startTime) / 1000),
      };

      if (mode === 'gateway' && handles.server) {
        body.nodeCount = handles.server.listNodes().length;
      }
      if (mode === 'node') {
        body.nodeId = config.gateway.nodeId;
        body.connected = handles.client?.isConnected() ?? false;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });
}
