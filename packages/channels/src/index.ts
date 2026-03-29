export type {
  ChannelPlugin,
  ChannelMeta,
  ChannelId,
  ChannelConfig,
  CommandDef,
  InboundMessage,
  OutboundMessage,
  MessageHandler,
} from './types.js';
export { ChannelManager } from './manager.js';
export type { PairingProvider } from './manager.js';
export { createChannelManager } from './factory.js';
export { chunkMarkdown, CHANNEL_LIMITS } from './chunking.js';
export { createSlackChannel, type SlackChannelConfig } from './adapters/slack.js';
export { createDiscordChannel, type DiscordChannelConfig } from './adapters/discord.js';
export { createTelegramChannel, type TelegramChannelConfig } from './adapters/telegram.js';
export { createMatrixChannel, type MatrixChannelConfig } from './adapters/matrix.js';
export { createFeishuChannel, type FeishuChannelConfig } from './adapters/feishu.js';
export { createWeChatChannel, type WeChatChannelConfig } from './adapters/wechat.js';
export { createWhatsAppChannel, type WhatsAppChannelConfig } from './adapters/whatsapp.js';
export { createSignalChannel, type SignalChannelConfig } from './adapters/signal.js';
export { createIrcChannel, type IrcChannelConfig } from './adapters/irc.js';
