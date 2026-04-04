import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message as DiscordMessage,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage, CommandDef } from '../types.js';
import { chunkMarkdown, CHANNEL_LIMITS } from '../chunking.js';

export interface DiscordChannelConfig {
  token: string;
  applicationId?: string;
  allowFrom: string[];
  channelIds: string[];
  commands?: CommandDef[];
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

  async function registerSlashCommands(): Promise<void> {
    if (!config.applicationId || !config.commands?.length) return;

    try {
      const rest = new REST({ version: '10' }).setToken(config.token);
      const commands = config.commands.map((cmd) => {
        const builder = new SlashCommandBuilder()
          .setName(cmd.name)
          .setDescription(cmd.description);
        if (cmd.hasArgs) {
          builder.addStringOption((opt) =>
            opt.setName('args').setDescription('Arguments').setRequired(false),
          );
        }
        return builder.toJSON();
      });

      await rest.put(
        Routes.applicationCommands(config.applicationId),
        { body: commands },
      );
    } catch {
      // Non-critical — bot works without slash commands
    }
  }

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
          routeTo: message.channelId,
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

      // Handle slash command interactions
      client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        const cmd = interaction as ChatInputCommandInteraction;

        if (!this.isAllowed(cmd.user.id)) {
          await cmd.reply({ content: 'Not authorized.', ephemeral: true });
          return;
        }

        // Enforce same channel routing as text messages:
        // DMs always allowed; guild messages require mention OR configured channel
        const isDM = !cmd.inGuild();
        const isThread = cmd.channel?.isThread?.() ?? false;
        const parentId = isThread ? (cmd.channel as { parentId?: string | null }).parentId ?? '' : '';
        if (!isDM) {
          const routeIds = [cmd.channelId ?? ''];
          if (parentId) routeIds.push(parentId);
          if (!shouldHandleDiscordMessage({ isDM: false, isMentioned: false, routeIds, channelIds: config.channelIds })) {
            await cmd.reply({ content: 'Not available in this channel.', ephemeral: true });
            return;
          }
        }

        // Read arguments for commands that accept them
        const args = cmd.options.getString('args') ?? '';
        const text = args ? `/${cmd.commandName} ${args}` : `/${cmd.commandName}`;

        // Match session IDs with text message logic
        const sessionId = isDM
          ? `dm:${cmd.channelId}`
          : isThread
            ? `thread:${cmd.channelId}`
            : `channel:${cmd.channelId}`;

        const inbound: InboundMessage = {
          channelId: 'discord',
          routeTo: cmd.channelId ?? undefined,
          senderId: cmd.user.id,
          senderName: cmd.user.username,
          text,
          sessionId,
          threadId: isThread ? cmd.channelId ?? undefined : undefined,
          timestamp: cmd.createdTimestamp,
        };

        // All slash command replies are ephemeral (only visible to invoking user)
        await cmd.deferReply({ ephemeral: true });
        const response = await handler(inbound);
        if (response) {
          const chunks = chunkMarkdown(response, limit);
          await cmd.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await cmd.followUp({ content: chunks[i], ephemeral: true });
          }
        } else {
          await cmd.editReply('Done.');
        }
      });

      await client.login(config.token);
      connected = true;

      // Register slash commands after login
      await registerSlashCommands();
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
