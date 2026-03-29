import * as net from 'node:net';
import * as tls from 'node:tls';
import type { ChannelPlugin, MessageHandler, OutboundMessage, InboundMessage } from '../types.js';
import { chunkMarkdown, CHANNEL_LIMITS } from '../chunking.js';

/** Split a text chunk into individual IRC-safe PRIVMSG lines.
 * Empty lines are sent as a single space to preserve formatting. */
export function splitIrcLines(text: string): string[] {
  return text.replace(/\r/g, '').split('\n').map((line) => line || ' ');
}

export interface IrcChannelConfig {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  password?: string;
  channels: string[];
  allowFrom: string[];
}

/** Parse a raw IRC protocol line into prefix, command, and params. */
export function parseIrcLine(line: string): { prefix?: string; command: string; params: string[] } {
  let prefix: string | undefined;
  let rest = line;

  if (rest.startsWith(':')) {
    const idx = rest.indexOf(' ');
    prefix = rest.slice(1, idx);
    rest = rest.slice(idx + 1);
  }

  const trailingIdx = rest.indexOf(' :');
  let trailing: string | undefined;
  if (trailingIdx !== -1) {
    trailing = rest.slice(trailingIdx + 2);
    rest = rest.slice(0, trailingIdx);
  }

  const parts = rest.split(' ').filter(Boolean);
  const command = parts[0];
  const params = parts.slice(1);
  if (trailing !== undefined) params.push(trailing);

  return { prefix, command, params };
}

/** Extract the nickname from an IRC prefix (nick!user@host). */
export function extractIrcNick(prefix: string): string {
  const idx = prefix.indexOf('!');
  return idx !== -1 ? prefix.slice(0, idx) : prefix;
}

export function createIrcChannel(config: IrcChannelConfig): ChannelPlugin {
  let socket: net.Socket | tls.TLSSocket | null = null;
  let connected = false;
  let handler: MessageHandler | null = null;
  let buffer = '';
  const limit = CHANNEL_LIMITS.irc;

  function send(line: string): void {
    socket?.write(`${line}\r\n`);
  }

  return {
    id: 'irc',
    meta: { name: 'IRC', emoji: '#' },

    async start(h: MessageHandler) {
      handler = h;

      return new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          if (config.password) send(`PASS ${config.password}`);
          send(`NICK ${config.nick}`);
          send(`USER ${config.nick} 0 * :CereWorker`);
        };

        if (config.tls) {
          socket = tls.connect({ host: config.host, port: config.port }, onConnect);
        } else {
          socket = net.connect({ host: config.host, port: config.port }, onConnect);
        }

        socket.setEncoding('utf-8');

        socket.on('data', (data: string) => {
          buffer += data;
          const lines = buffer.split('\r\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line) continue;
            void handleLine(line);
          }
        });

        socket.on('error', (err) => {
          if (!connected) reject(err);
        });

        socket.on('close', () => {
          connected = false;
        });

        async function handleLine(line: string): Promise<void> {
          const parsed = parseIrcLine(line);

          if (parsed.command === 'PING') {
            send(`PONG :${parsed.params[0] ?? ''}`);
            return;
          }

          // RPL_WELCOME — we're registered
          if (parsed.command === '001') {
            connected = true;
            // Identify with NickServ if password set
            if (config.password) {
              send(`PRIVMSG NickServ :IDENTIFY ${config.password}`);
            }
            // Join channels
            for (const ch of config.channels) {
              send(`JOIN ${ch}`);
            }
            resolve();
            return;
          }

          if (parsed.command === 'PRIVMSG' && parsed.prefix && handler) {
            const nick = extractIrcNick(parsed.prefix);
            if (nick === config.nick) return; // skip own messages

            const target = parsed.params[0]; // channel or nick
            const text = parsed.params[1] ?? '';

            const inbound: InboundMessage = {
              channelId: 'irc',
              senderId: nick,
              senderName: nick,
              text,
              sessionId: target.startsWith('#') ? `channel:${target}` : `dm:${nick}`,
              timestamp: Date.now(),
            };

            const response = await handler(inbound);
            if (response) {
              const replyTarget = target.startsWith('#') ? target : nick;
              const chunks = chunkMarkdown(response, limit);
              for (const chunk of chunks) {
                for (const line of splitIrcLines(chunk)) {
                  send(`PRIVMSG ${replyTarget} :${line}`);
                }
              }
            }
          }
        }
      });
    },

    async stop() {
      if (socket) {
        send('QUIT :CereWorker shutting down');
        socket.destroy();
        socket = null;
        connected = false;
      }
    },

    async send(msg: OutboundMessage) {
      if (!socket) throw new Error('IRC not started');
      const chunks = chunkMarkdown(msg.text, limit);
      for (const chunk of chunks) {
        for (const line of splitIrcLines(chunk)) {
          send(`PRIVMSG ${msg.to} :${line}`);
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
