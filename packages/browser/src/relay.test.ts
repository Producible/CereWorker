import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { BrowserRelay } from './relay.js';

describe('BrowserRelay', () => {
  let relay: BrowserRelay | null = null;
  let extensionSocket: WebSocket | null = null;

  afterEach(async () => {
    if (extensionSocket) {
      extensionSocket.close();
      extensionSocket = null;
    }
    if (relay) {
      await relay.stop();
      relay = null;
    }
  });

  it('rejects pending commands immediately when aborted and clears the pending entry', async () => {
    relay = new BrowserRelay({ port: 0 });
    await relay.start();

    const port = (((relay as unknown as { httpServer: { address(): AddressInfo | null } }).httpServer.address()) as AddressInfo).port;
    extensionSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });

    const abortController = new AbortController();
    const sendPromise = relay.send('navigate', { url: 'https://example.com' }, 30_000, abortController.signal);

    expect((relay as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);

    abortController.abort();

    await expect(sendPromise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Command navigate aborted',
    });
    expect((relay as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });
});
