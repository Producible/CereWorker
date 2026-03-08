import { Client, GatewayIntentBits, Events, type Message as DiscordMessage } from 'discord.js';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';

export interface DiscordChannelConfig {
  token: string;
  applicationId?: string;
  allowFrom: string[];
}

export function createDiscordChannel(config: DiscordChannelConfig): ChannelPlugin {
  let client: Client | null = null;
  let connected = false;

  return {
    id: 'discord',
    meta: { name: 'Discord', emoji: 'D' },

    async start(handler: MessageHandler) {
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      client.on(Events.MessageCreate, async (message: DiscordMessage) => {
        // Ignore bot's own messages
        if (message.author.bot) return;

        // Only respond when mentioned or in DMs
        const isDM = !message.guild;
        const isMentioned = client?.user && message.mentions.has(client.user);
        if (!isDM && !isMentioned) return;

        // Strip mention from text
        let text = message.content;
        if (client?.user) {
          text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
        }

        if (!text) return;

        const inbound: InboundMessage = {
          channelId: 'discord',
          senderId: message.author.id,
          senderName: message.author.username,
          text,
          threadId: message.channel.isThread() ? message.channel.id : undefined,
          timestamp: message.createdTimestamp,
        };

        const response = await handler(inbound);
        if (response) {
          // Discord has a 2000 char limit per message
          const chunks = chunkText(response, 2000);
          for (const chunk of chunks) {
            await message.reply(chunk);
          }
        }
      });

      await client.login(config.token);
      connected = true;
    },

    async stop() {
      if (client) {
        await client.destroy();
        connected = false;
      }
    },

    async send(msg: OutboundMessage) {
      if (!client) throw new Error('Discord not started');
      const channel = await client.channels.fetch(msg.to);
      if (channel && 'send' in channel) {
        const chunks = chunkText(msg.text, 2000);
        for (const chunk of chunks) {
          await (channel as { send: (text: string) => Promise<unknown> }).send(chunk);
        }
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
    // Try to break at a newline
    let breakAt = remaining.lastIndexOf('\n', limit);
    if (breakAt <= 0) breakAt = limit;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return chunks;
}
