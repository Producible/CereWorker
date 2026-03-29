export interface ChannelMeta {
  name: string;
  emoji: string;
}

export interface InboundMessage {
  channelId: string;
  senderId: string;
  senderName?: string;
  text: string;
  sessionId?: string;
  threadId?: string;
  replyToId?: string;
  timestamp: number;
  raw?: unknown;
}

export interface OutboundMessage {
  to: string;
  text: string;
  threadId?: string;
  replyToId?: string;
}

export type MessageHandler = (msg: InboundMessage) => Promise<string | void>;

export interface ChannelPlugin {
  id: string;
  meta: ChannelMeta;

  /** Start the channel (connect, listen for events) */
  start(handler: MessageHandler): Promise<void>;

  /** Stop the channel gracefully */
  stop(): Promise<void>;

  /** Send a text message */
  send(msg: OutboundMessage): Promise<void>;

  /** Check if a sender is allowed (security) */
  isAllowed(senderId: string): boolean;

  /** Whether the channel is currently connected */
  isConnected(): boolean;
}

export type ChannelId = 'slack' | 'discord' | 'telegram' | 'matrix' | 'feishu' | 'wechat';

export interface ChannelConfig {
  enabled: boolean;
  allowFrom: string[];
  [key: string]: unknown;
}
