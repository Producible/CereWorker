import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';
import { chunkMarkdown, CHANNEL_LIMITS } from '../chunking.js';

export interface SignalChannelConfig {
  account: string;
  signalCliUrl: string;
  allowFrom: string[];
}

export function createSignalChannel(config: SignalChannelConfig): ChannelPlugin {
  let connected = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const limit = CHANNEL_LIMITS.signal;
  const baseUrl = config.signalCliUrl.replace(/\/+$/, '');

  async function receive(): Promise<unknown[]> {
    const url = `${baseUrl}/v1/receive/${encodeURIComponent(config.account)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Signal receive: ${res.status}`);
    return (await res.json()) as unknown[];
  }

  async function sendMessage(to: string, text: string): Promise<void> {
    const res = await fetch(`${baseUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        number: config.account,
        recipients: [to],
      }),
    });
    if (!res.ok) throw new Error(`Signal send: ${res.status}`);
  }

  return {
    id: 'signal',
    meta: { name: 'Signal', emoji: 'S' },

    async start(handler: MessageHandler) {
      // Verify connectivity
      try {
        const res = await fetch(`${baseUrl}/v1/about`, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`Signal CLI not reachable: ${res.status}`);
      } catch (err) {
        throw new Error(`Cannot connect to signal-cli at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }

      connected = true;
      polling = true;

      const poll = async () => {
        if (!polling) return;
        try {
          const messages = await receive();
          for (const raw of messages) {
            const envelope = (raw as { envelope?: Record<string, unknown> }).envelope;
            if (!envelope) continue;

            const dataMessage = envelope.dataMessage as { message?: string; groupInfo?: { groupId?: string } } | undefined;
            if (!dataMessage?.message) continue;

            const source = String(envelope.source ?? '');
            const groupId = dataMessage.groupInfo?.groupId;

            const inbound: InboundMessage = {
              channelId: 'signal',
              senderId: source,
              text: dataMessage.message,
              sessionId: groupId ? `group:${groupId}` : `dm:${source}`,
              timestamp: Number(envelope.timestamp ?? Date.now()),
              raw,
            };

            const response = await handler(inbound);
            if (response) {
              const to = groupId ?? source;
              const chunks = chunkMarkdown(response, limit);
              for (const chunk of chunks) {
                await sendMessage(to, chunk);
              }
            }
          }
        } catch {
          // Poll failure is non-fatal — retry on next tick
        }
        if (polling) {
          pollTimer = setTimeout(poll, 1000);
        }
      };

      void poll();
    },

    async stop() {
      polling = false;
      connected = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    },

    async send(msg: OutboundMessage) {
      const chunks = chunkMarkdown(msg.text, limit);
      for (const chunk of chunks) {
        await sendMessage(msg.to, chunk);
      }
    },

    isAllowed(senderId: string) {
      if (config.allowFrom.length === 0) return true;
      return config.allowFrom.includes(senderId);
    },

    isConnected() {
      return connected;
    },
  };
}
