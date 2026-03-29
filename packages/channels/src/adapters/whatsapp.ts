import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';
import { chunkMarkdown, CHANNEL_LIMITS } from '../chunking.js';

export interface WhatsAppChannelConfig {
  allowFrom: string[];
  authDir?: string;
}

export function createWhatsAppChannel(config: WhatsAppChannelConfig): ChannelPlugin {
  let sock: ReturnType<typeof import('@whiskeysockets/baileys').default> | null = null;
  let connected = false;
  const limit = CHANNEL_LIMITS.whatsapp;
  const authDir = config.authDir ?? join(homedir(), '.cereworker', 'whatsapp-auth');

  return {
    id: 'whatsapp',
    meta: { name: 'WhatsApp', emoji: 'W' },

    async start(handler: MessageHandler) {
      // Dynamic import — baileys is an optional dependency
      const baileys = await import('@whiskeysockets/baileys');
      const makeWASocket = baileys.default;
      const { useMultiFileAuthState, DisconnectReason } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          connected = false;
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          // Reconnect unless logged out
          if (statusCode !== DisconnectReason.loggedOut) {
            // Re-start after a brief delay
            setTimeout(() => {
              if (sock) void this.start(handler);
            }, 3000);
          }
        } else if (connection === 'open') {
          connected = true;
        }
      });

      sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
        if (type !== 'notify') return;

        for (const msg of msgs) {
          if (msg.key.fromMe) continue;
          if (!msg.message) continue;

          const text =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            '';
          if (!text) continue;

          const jid = msg.key.remoteJid ?? '';
          const senderId = msg.key.participant ?? jid; // participant in groups, jid in DMs
          const isGroup = jid.endsWith('@g.us');

          const inbound: InboundMessage = {
            channelId: 'whatsapp',
            senderId,
            senderName: msg.pushName ?? undefined,
            text,
            sessionId: isGroup ? `group:${jid}` : `dm:${senderId}`,
            timestamp: (msg.messageTimestamp as number) * 1000 || Date.now(),
            raw: msg,
          };

          const response = await handler(inbound);
          if (response) {
            const chunks = chunkMarkdown(response, limit);
            for (const chunk of chunks) {
              await sock!.sendMessage(jid, { text: chunk });
            }
          }
        }
      });
    },

    async stop() {
      if (sock) {
        sock.end(undefined);
        sock = null;
        connected = false;
      }
    },

    async send(msg: OutboundMessage) {
      if (!sock) throw new Error('WhatsApp not started');
      const chunks = chunkMarkdown(msg.text, limit);
      for (const chunk of chunks) {
        await sock.sendMessage(msg.to, { text: chunk });
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
