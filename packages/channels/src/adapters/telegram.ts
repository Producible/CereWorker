import { Telegraf, type Context } from 'telegraf';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';
import { chunkMarkdown, CHANNEL_LIMITS } from '../chunking.js';

export interface TelegramChannelConfig {
  token: string;
  allowFrom: string[];
}

export function createTelegramChannel(config: TelegramChannelConfig): ChannelPlugin {
  let bot: Telegraf | null = null;
  let connected = false;
  const limit = CHANNEL_LIMITS.telegram;

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
          const chunks = chunkMarkdown(response, limit);
          for (const chunk of chunks) {
            await ctx.reply(chunk, {
              reply_parameters: { message_id: message.message_id },
            });
          }
        }
      });

      // Register slash commands with Telegram for autocomplete
      await bot.telegram.setMyCommands([
        { command: 'help', description: 'Show help' },
        { command: 'model', description: 'Show or switch model' },
        { command: 'provider', description: 'Show or switch provider' },
        { command: 'config', description: 'Show config' },
        { command: 'auto', description: 'Toggle auto mode' },
        { command: 'memory', description: 'Show memory' },
        { command: 'skills', description: 'List skills' },
        { command: 'agents', description: 'List sub-agents' },
        { command: 'channels', description: 'List channels' },
        { command: 'nodes', description: 'Gateway nodes' },
        { command: 'finetune', description: 'Fine-tune controls' },
        { command: 'task', description: 'Run or list tasks' },
        { command: 'conversations', description: 'List conversations' },
        { command: 'stop', description: 'Emergency stop' },
      ]).catch(() => { /* non-critical */ });

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
      const chunks = chunkMarkdown(msg.text, limit);
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
