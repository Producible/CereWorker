import { WechatyBuilder, type Wechaty, type Message as WechatyMessage } from 'wechaty';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';

export interface WeChatChannelConfig {
  puppet: string;
  token?: string;
  allowFrom: string[];
}

export function createWeChatChannel(config: WeChatChannelConfig): ChannelPlugin {
  let bot: Wechaty | null = null;
  let connected = false;

  return {
    id: 'wechat',
    meta: { name: 'WeChat', emoji: 'W' },

    async start(handler: MessageHandler) {
      bot = WechatyBuilder.build({
        name: 'cereworker',
        puppet: config.puppet as 'wechaty-puppet-wechat4u',
        puppetOptions: config.token ? { token: config.token } : undefined,
      });

      bot.on('message', async (message: WechatyMessage) => {
        // Skip self messages
        if (message.self()) return;

        // Only handle text messages
        if (message.type() !== bot!.Message.Type.Text) return;

        const text = message.text();
        if (!text) return;

        const talker = message.talker();
        const senderId = talker.id;
        const room = message.room();

        const inbound: InboundMessage = {
          channelId: 'wechat',
          senderId,
          senderName: talker.name(),
          text,
          threadId: room ? room.id : undefined,
          timestamp: message.date().getTime(),
        };

        const response = await handler(inbound);
        if (response) {
          // Chunk long messages (WeChat has ~4096 char limit for text)
          const chunks = chunkText(response, 4096);
          for (const chunk of chunks) {
            if (room) {
              await room.say(chunk);
            } else {
              await talker.say(chunk);
            }
          }
        }
      });

      bot.on('login', (user) => {
        console.log(`[WeChat] Logged in as ${user.name()}`);
        connected = true;
      });

      bot.on('logout', () => {
        console.log('[WeChat] Logged out');
        connected = false;
      });

      bot.on('error', (error) => {
        console.error('[WeChat] Error:', error);
      });

      await bot.start();
    },

    async stop() {
      if (bot) {
        await bot.stop();
        connected = false;
        bot = null;
      }
    },

    async send(msg: OutboundMessage) {
      if (!bot) throw new Error('WeChat not started');

      const contact = await bot.Contact.find({ id: msg.to });
      if (contact) {
        const chunks = chunkText(msg.text, 4096);
        for (const chunk of chunks) {
          await contact.say(chunk);
        }
        return;
      }

      // Try as room
      const room = await bot.Room.find({ id: msg.to });
      if (room) {
        const chunks = chunkText(msg.text, 4096);
        for (const chunk of chunks) {
          await room.say(chunk);
        }
        return;
      }

      throw new Error(`WeChat contact/room not found: ${msg.to}`);
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

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf('\n', limit);
    if (breakAt <= 0) breakAt = limit;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return chunks;
}
