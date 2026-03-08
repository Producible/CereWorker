import { App as SlackApp, type SlackEventMiddlewareArgs } from '@slack/bolt';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';

export interface SlackChannelConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  allowFrom: string[];
}

export function createSlackChannel(config: SlackChannelConfig): ChannelPlugin {
  let app: SlackApp | null = null;
  let connected = false;

  return {
    id: 'slack',
    meta: { name: 'Slack', emoji: '#' },

    async start(handler: MessageHandler) {
      app = new SlackApp({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
        ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      });

      app.message(async ({ message, say }: SlackEventMiddlewareArgs<'message'> & { say: Function }) => {
        if (message.subtype) return; // skip bot messages, edits, etc.
        if (!('text' in message) || !message.text) return;

        const inbound: InboundMessage = {
          channelId: 'slack',
          senderId: ('user' in message ? message.user : '') ?? '',
          text: message.text,
          threadId: ('thread_ts' in message ? message.thread_ts : undefined) as string | undefined,
          timestamp: parseFloat(message.ts) * 1000,
        };

        const response = await handler(inbound);
        if (response) {
          await say({
            text: response,
            thread_ts: inbound.threadId ?? message.ts,
          });
        }
      });

      await app.start();
      connected = true;
    },

    async stop() {
      if (app) {
        await app.stop();
        connected = false;
      }
    },

    async send(msg: OutboundMessage) {
      if (!app) throw new Error('Slack not started');
      await app.client.chat.postMessage({
        channel: msg.to,
        text: msg.text,
        thread_ts: msg.threadId,
      });
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
