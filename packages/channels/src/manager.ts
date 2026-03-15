import type { ChannelPlugin, MessageHandler, OutboundMessage, ChannelId } from './types.js';

export interface PairingProvider {
  isApproved(channelId: string, senderId: string): boolean;
  createPairingCode(channelId: string, senderId: string, senderName?: string): string | null;
}

export class ChannelManager {
  private channels = new Map<string, ChannelPlugin>();
  private handler: MessageHandler | null = null;
  private dmPolicy: 'pairing' | 'open' = 'open';
  private pairingProvider: PairingProvider | null = null;

  /** Set the global message handler (usually wired to the orchestrator) */
  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Set the DM access policy */
  setDmPolicy(policy: 'pairing' | 'open'): void {
    this.dmPolicy = policy;
  }

  /** Set the pairing provider for pairing mode */
  setPairingProvider(provider: PairingProvider): void {
    this.pairingProvider = provider;
  }

  /** Register a channel plugin */
  register(channel: ChannelPlugin): void {
    this.channels.set(channel.id, channel);
  }

  /** Get a registered channel by ID */
  get(id: string): ChannelPlugin | undefined {
    return this.channels.get(id);
  }

  /** List all registered channels */
  list(): ChannelPlugin[] {
    return Array.from(this.channels.values());
  }

  /** List connected channels */
  listConnected(): ChannelPlugin[] {
    return this.list().filter((ch) => ch.isConnected());
  }

  /** Start all registered channels */
  async startAll(): Promise<void> {
    if (!this.handler) {
      throw new Error('No message handler set. Call setHandler() before startAll().');
    }

    const handler = this.handler;

    const results = await Promise.allSettled(
      this.list().map(async (channel) => {
        try {
          await channel.start(async (msg) => {
            // Pairing mode: PairingStore is the single source of truth
            if (this.dmPolicy === 'pairing' && this.pairingProvider) {
              if (this.pairingProvider.isApproved(msg.channelId, msg.senderId)) {
                return handler(msg);
              }
              // Issue pairing challenge
              const code = this.pairingProvider.createPairingCode(
                msg.channelId, msg.senderId, msg.senderName,
              );
              if (code) {
                return `Access required. Your pairing code: ${code}\nAsk the bot owner to run: cereworker approve ${code}`;
              }
              return; // rate limited, silent drop
            }

            // Open mode: use legacy isAllowed behavior
            if (!channel.isAllowed(msg.senderId)) {
              return;
            }
            return handler(msg);
          });
        } catch (err) {
          console.error(`[ChannelManager] Failed to start ${channel.id}:`, err);
          throw err;
        }
      }),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      console.warn(`[ChannelManager] ${failures.length} channel(s) failed to start`);
    }
  }

  /** Stop all channels */
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      this.list().map(async (channel) => {
        try {
          await channel.stop();
        } catch (err) {
          console.error(`[ChannelManager] Failed to stop ${channel.id}:`, err);
        }
      }),
    );
  }

  /** Send a message to a specific channel */
  async send(channelId: string, msg: OutboundMessage): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    if (!channel.isConnected()) throw new Error(`Channel not connected: ${channelId}`);
    await channel.send(msg);
  }

  /** Broadcast a message to all connected channels */
  async broadcast(msg: OutboundMessage): Promise<void> {
    await Promise.allSettled(
      this.listConnected().map((ch) => ch.send(msg)),
    );
  }
}
