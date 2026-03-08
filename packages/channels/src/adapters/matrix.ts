import sdk from 'matrix-js-sdk';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';

export interface MatrixChannelConfig {
  homeserver: string;
  token: string;
  userId: string;
  allowFrom: string[];
}

export function createMatrixChannel(config: MatrixChannelConfig): ChannelPlugin {
  let client: sdk.MatrixClient | null = null;
  let connected = false;

  return {
    id: 'matrix',
    meta: { name: 'Matrix', emoji: 'M' },

    async start(handler: MessageHandler) {
      client = sdk.createClient({
        baseUrl: config.homeserver,
        accessToken: config.token,
        userId: config.userId,
      });

      client.on(sdk.RoomEvent.Timeline, async (event, room) => {
        if (!room) return;
        if (event.getType() !== 'm.room.message') return;
        if (event.getSender() === config.userId) return; // ignore own messages

        const content = event.getContent();
        if (content.msgtype !== 'm.text') return;

        const senderId = event.getSender() ?? '';
        const inbound: InboundMessage = {
          channelId: 'matrix',
          senderId,
          text: content.body ?? '',
          threadId: room.roomId,
          timestamp: event.getTs(),
        };

        const response = await handler(inbound);
        if (response) {
          await client!.sendTextMessage(room.roomId, response);
        }
      });

      await client.startClient({ initialSyncLimit: 0 });
      connected = true;
    },

    async stop() {
      if (client) {
        client.stopClient();
        connected = false;
      }
    },

    async send(msg: OutboundMessage) {
      if (!client) throw new Error('Matrix not started');
      await client.sendTextMessage(msg.to, msg.text);
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
