import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';
import { chunkMarkdown, CHANNEL_LIMITS } from '../chunking.js';

export interface WeChatChannelConfig {
  puppet: string;
  token?: string;
  allowFrom: string[];
}

export function createWeChatChannel(config: WeChatChannelConfig): ChannelPlugin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bot: any = null;
  let connected = false;
  const limit = CHANNEL_LIMITS.wechat;

  return {
    id: 'wechat',
    meta: { name: 'WeChat', emoji: 'W' },

    async start(handler: MessageHandler) {
      const mod = 'wechaty';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wechaty: any = await import(mod).catch(() => null);
      if (!wechaty) {
        throw new Error(
          'WeChat requires the wechaty package. Install it:\n  npm install -g wechaty wechaty-puppet-wechat4u',
        );
      }

      bot = wechaty.WechatyBuilder.build({
        name: 'cereworker',
        puppet: config.puppet as 'wechaty-puppet-wechat4u',
        puppetOptions: config.token ? { token: config.token } : undefined,
      });

      bot.on('message', async (message: any) => {
        if (message.self()) return;
        if (message.type() !== bot!.Message.Type.Text) return;

        const text = message.text();
        if (!text) return;

        const talker = message.talker();
        const senderId = talker.id;
        const room = message.room();

        const inbound: InboundMessage = {
          channelId: 'wechat',
          routeTo: room ? room.id : talker.id,
          senderId,
          senderName: talker.name(),
          text,
          sessionId: room ? `room:${room.id}` : `dm:${talker.id}`,
          threadId: room ? room.id : undefined,
          timestamp: message.date().getTime(),
        };

        const response = await handler(inbound);
        if (response) {
          const chunks = chunkMarkdown(response, limit);
          for (const chunk of chunks) {
            if (room) {
              await room.say(chunk);
            } else {
              await talker.say(chunk);
            }
          }
        }
      });

      bot.on('login', (user: any) => {
        console.log(`[WeChat] Logged in as ${user.name()}`);
        connected = true;
      });

      bot.on('logout', () => {
        console.log('[WeChat] Logged out');
        connected = false;
      });

      bot.on('error', (error: any) => {
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
        const chunks = chunkMarkdown(msg.text, limit);
        for (const chunk of chunks) {
          await contact.say(chunk);
        }
        return;
      }

      const room = await bot.Room.find({ id: msg.to });
      if (room) {
        const chunks = chunkMarkdown(msg.text, limit);
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
