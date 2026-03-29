import { Client, GatewayIntentBits, Events, Partials, type Message as DiscordMessage } from 'discord.js';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';
import { chunkMarkdown, CHANNEL_LIMITS } from '../chunking.js';

export interface DiscordChannelConfig {
  token: string;
  applicationId?: string;
  allowFrom: string[];
  channelIds: string[];
}

export function getDiscordClientOptions() {
  return {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  };
}

export function shouldHandleDiscordMessage(params: {
  isDM: boolean;
  isMentioned: boolean;
  routeIds: string[];
  channelIds: string[];
}): boolean {
  if (params.isDM) return true;
  if (params.isMentioned) return true;
  if (params.channelIds.length === 0) return false;
  return params.routeIds.some((id) => params.channelIds.includes(id));
}

export function createDiscordChannel(config: DiscordChannelConfig): ChannelPlugin {
  let client: Client | null = null;
  let connected = false;
  const limit = CHANNEL_LIMITS.discord;

  return {
    id: 'discord',
    meta: { name: 'Discord', emoji: 'D' },

    async start(handler: MessageHandler) {
      client = new Client(getDiscordClientOptions());

      client.on(Events.MessageCreate, async (message: DiscordMessage) => {
        // Ignore bot's own messages
        if (message.author.bot) return;

        // Reply in DMs, on mentions, or in explicitly configured server channels.
        const isDM = !message.inGuild();
        const isMentioned = client?.user && message.mentions.has(client.user);
        const routeIds = [message.channelId];
        if (message.channel.isThread() && message.channel.parentId) {
          routeIds.push(message.channel.parentId);
        }
        if (!shouldHandleDiscordMessage({ isDM, isMentioned: Boolean(isMentioned), routeIds, channelIds: config.channelIds })) {
          return;
        }

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
          sessionId: isDM
            ? `dm:${message.channelId}`
            : message.channel.isThread()
              ? `thread:${message.channel.id}`
              : `channel:${message.channelId}`,
          threadId: message.channel.isThread() ? message.channel.id : undefined,
          timestamp: message.createdTimestamp,
        };

        const response = await handler(inbound);
        if (response) {
          const chunks = chunkMarkdown(response, limit);
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
        const chunks = chunkMarkdown(msg.text, limit);
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
