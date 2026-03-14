import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelManager } from './manager.js';
import type { ChannelPlugin, OutboundMessage } from './types.js';

function mockChannel(id: string, connected = true): ChannelPlugin {
  return {
    id,
    meta: { name: id, emoji: '' },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    isAllowed: vi.fn().mockReturnValue(true),
    isConnected: vi.fn().mockReturnValue(connected),
  };
}

describe('ChannelManager', () => {
  let manager: ChannelManager;

  beforeEach(() => {
    manager = new ChannelManager();
  });

  it('registers and retrieves a channel', () => {
    const ch = mockChannel('slack');
    manager.register(ch);
    expect(manager.get('slack')).toBe(ch);
  });

  it('returns undefined for unknown channel', () => {
    expect(manager.get('unknown')).toBeUndefined();
  });

  it('lists all registered channels', () => {
    manager.register(mockChannel('slack'));
    manager.register(mockChannel('discord'));
    expect(manager.list()).toHaveLength(2);
  });

  it('listConnected filters by connection status', () => {
    manager.register(mockChannel('slack', true));
    manager.register(mockChannel('discord', false));
    const connected = manager.listConnected();
    expect(connected).toHaveLength(1);
    expect(connected[0].id).toBe('slack');
  });

  it('startAll throws without handler', async () => {
    manager.register(mockChannel('slack'));
    await expect(manager.startAll()).rejects.toThrow('No message handler set');
  });

  it('startAll calls start on all channels', async () => {
    const ch1 = mockChannel('slack');
    const ch2 = mockChannel('discord');
    manager.register(ch1);
    manager.register(ch2);
    manager.setHandler(vi.fn());
    await manager.startAll();
    expect(ch1.start).toHaveBeenCalledOnce();
    expect(ch2.start).toHaveBeenCalledOnce();
  });

  it('startAll continues on partial failure', async () => {
    const ch1 = mockChannel('slack');
    (ch1.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    const ch2 = mockChannel('discord');
    manager.register(ch1);
    manager.register(ch2);
    manager.setHandler(vi.fn());
    // Should not throw — uses allSettled
    await manager.startAll();
    expect(ch2.start).toHaveBeenCalledOnce();
  });

  it('stopAll calls stop on all channels', async () => {
    const ch1 = mockChannel('slack');
    const ch2 = mockChannel('discord');
    manager.register(ch1);
    manager.register(ch2);
    await manager.stopAll();
    expect(ch1.stop).toHaveBeenCalledOnce();
    expect(ch2.stop).toHaveBeenCalledOnce();
  });

  it('send sends to a specific channel', async () => {
    const ch = mockChannel('slack');
    manager.register(ch);
    const msg: OutboundMessage = { to: 'user1', text: 'hello' };
    await manager.send('slack', msg);
    expect(ch.send).toHaveBeenCalledWith(msg);
  });

  it('send throws for unknown channel', async () => {
    const msg: OutboundMessage = { to: 'user1', text: 'hello' };
    await expect(manager.send('unknown', msg)).rejects.toThrow('Channel not found');
  });

  it('send throws for disconnected channel', async () => {
    const ch = mockChannel('slack', false);
    manager.register(ch);
    const msg: OutboundMessage = { to: 'user1', text: 'hello' };
    await expect(manager.send('slack', msg)).rejects.toThrow('Channel not connected');
  });

  it('broadcast sends to all connected channels', async () => {
    const ch1 = mockChannel('slack', true);
    const ch2 = mockChannel('discord', true);
    const ch3 = mockChannel('telegram', false);
    manager.register(ch1);
    manager.register(ch2);
    manager.register(ch3);
    const msg: OutboundMessage = { to: 'all', text: 'broadcast' };
    await manager.broadcast(msg);
    expect(ch1.send).toHaveBeenCalledWith(msg);
    expect(ch2.send).toHaveBeenCalledWith(msg);
    expect(ch3.send).not.toHaveBeenCalled();
  });
});
