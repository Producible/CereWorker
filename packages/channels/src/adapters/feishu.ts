import * as lark from '@larksuiteoapi/node-sdk';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';
import { chunkMarkdown, CHANNEL_LIMITS } from '../chunking.js';

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  allowFrom: string[];
}

export function createFeishuChannel(config: FeishuChannelConfig): ChannelPlugin {
  let client: lark.Client | null = null;
  let eventDispatcher: lark.EventDispatcher | null = null;
  let wsClient: unknown | null = null;
  let connected = false;
  let messageHandler: MessageHandler | null = null;

  return {
    id: 'feishu',
    meta: { name: 'Feishu', emoji: 'F' },

    async start(handler: MessageHandler) {
      messageHandler = handler;

      client = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        appType: lark.AppType.SelfBuild,
      });

      eventDispatcher = new lark.EventDispatcher({
        verificationToken: config.verificationToken,
        encryptKey: config.encryptKey,
      });

      // Listen for messages
      eventDispatcher.register({
        'im.message.receive_v1': async (data: Record<string, unknown>) => {
          if (!messageHandler) return;

          const message = data.message as Record<string, unknown> | undefined;
          if (!message) return;

          const msgType = message.message_type as string;
          if (msgType !== 'text') return;

          let text = '';
          try {
            const content = JSON.parse(message.content as string);
            text = content.text ?? '';
          } catch {
            return;
          }

          if (!text) return;

          const sender = data.sender as Record<string, unknown> | undefined;
          const senderId = (sender?.sender_id as Record<string, unknown>)?.open_id as string ?? '';

          const inbound: InboundMessage = {
            channelId: 'feishu',
            senderId,
            text,
            threadId: message.root_id as string | undefined,
            timestamp: Number(message.create_time ?? Date.now()),
          };

          const response = await messageHandler(inbound);
          if (response && client) {
            const chatId = message.chat_id as string;
            const chunks = chunkMarkdown(response, CHANNEL_LIMITS.feishu);
            for (const chunk of chunks) {
              await client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                  receive_id: chatId,
                  msg_type: 'text',
                  content: JSON.stringify({ text: chunk }),
                },
              });
            }
          }
        },
      });

      // Use WebSocket client for real-time events
      wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.warn,
      });

      await (wsClient as lark.WSClient).start({ eventDispatcher });
      connected = true;
    },

    async stop() {
      connected = false;
      wsClient = null;
      eventDispatcher = null;
      client = null;
    },

    async send(msg: OutboundMessage) {
      if (!client) throw new Error('Feishu not started');
      const chunks = chunkMarkdown(msg.text, CHANNEL_LIMITS.feishu);
      for (const chunk of chunks) {
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: msg.to,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        });
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
