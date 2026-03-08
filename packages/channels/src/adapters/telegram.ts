import { Telegraf, type Context } from 'telegraf';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';

export interface TelegramChannelConfig {
  token: string;
  allowFrom: string[];
}

export function createTelegramChannel(config: TelegramChannelConfig): ChannelPlugin {
  let bot: Telegraf | null = null;
  let connected = false;

  return {
    id: 'telegram',
    meta: { name: 'Telegram', emoji: 'T' },

    async start(handler: MessageHandler) {
      bot = new Telegraf(config.token);

      bot.on('text', async (ctx: Context) => {
        const message = ctx.message;
        if (!message || !('text' in message)) return;

        const senderId = String(message.from?.id ?? '');
        const inbound: InboundMessage = {
          channelId: 'telegram',
          senderId,
          senderName: message.from?.username ?? message.from?.first_name,
          text: message.text,
          threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
          replyToId: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined,
          timestamp: message.date * 1000,
        };

        const response = await handler(inbound);
        if (response) {
          // Telegram has a 4096 char limit per message
          const chunks = chunkText(response, 4096);
          for (const chunk of chunks) {
            await ctx.reply(chunk, {
              reply_parameters: { message_id: message.message_id },
            });
          }
        }
      });

      // Use polling (simpler than webhooks for dev)
      await bot.launch();
      connected = true;

      // Graceful shutdown
      process.once('SIGINT', () => bot?.stop('SIGINT'));
      process.once('SIGTERM', () => bot?.stop('SIGTERM'));
    },

    async stop() {
      if (bot) {
        bot.stop();
        connected = false;
      }
    },

    async send(msg: OutboundMessage) {
      if (!bot) throw new Error('Telegram not started');
      const chunks = chunkText(msg.text, 4096);
      for (const chunk of chunks) {
        await bot.telegram.sendMessage(msg.to, chunk, {
          reply_parameters: msg.replyToId
            ? { message_id: parseInt(msg.replyToId, 10) }
            : undefined,
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
