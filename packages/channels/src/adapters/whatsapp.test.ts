import { describe, expect, it } from 'vitest';
import { createWhatsAppChannel } from './whatsapp.js';

describe('WhatsApp adapter', () => {
  it('has correct id and meta', () => {
    const channel = createWhatsAppChannel({ allowFrom: [] });
    expect(channel.id).toBe('whatsapp');
    expect(channel.meta.name).toBe('WhatsApp');
  });

  it('allows all senders when allowFrom is empty', () => {
    const channel = createWhatsAppChannel({ allowFrom: [] });
    expect(channel.isAllowed('12345@s.whatsapp.net')).toBe(true);
    expect(channel.isAllowed('anyone')).toBe(true);
  });

  it('restricts to allowFrom list when set', () => {
    const channel = createWhatsAppChannel({
      allowFrom: ['12345@s.whatsapp.net'],
    });
    expect(channel.isAllowed('12345@s.whatsapp.net')).toBe(true);
    expect(channel.isAllowed('99999@s.whatsapp.net')).toBe(false);
  });

  it('reports disconnected before start', () => {
    const channel = createWhatsAppChannel({ allowFrom: [] });
    expect(channel.isConnected()).toBe(false);
  });
});
