import { describe, expect, it } from 'vitest';
import { parseSignalEnvelope } from './signal.js';

describe('Signal envelope parser', () => {
  it('parses a direct message', () => {
    const raw = {
      envelope: {
        source: '+15551234567',
        timestamp: 1711234567890,
        dataMessage: {
          message: 'hello from signal',
        },
      },
    };

    const result = parseSignalEnvelope(raw);
    expect(result).not.toBeNull();
    expect(result!.channelId).toBe('signal');
    expect(result!.senderId).toBe('+15551234567');
    expect(result!.text).toBe('hello from signal');
    expect(result!.sessionId).toBe('dm:+15551234567');
    expect(result!.timestamp).toBe(1711234567890);
  });

  it('parses a group message', () => {
    const raw = {
      envelope: {
        source: '+15559876543',
        timestamp: 1711234567891,
        dataMessage: {
          message: 'group msg',
          groupInfo: { groupId: 'abc123' },
        },
      },
    };

    const result = parseSignalEnvelope(raw);
    expect(result).not.toBeNull();
    expect(result!.senderId).toBe('+15559876543');
    expect(result!.sessionId).toBe('group:abc123');
  });

  it('returns null for missing envelope', () => {
    expect(parseSignalEnvelope({})).toBeNull();
    expect(parseSignalEnvelope({ envelope: {} })).toBeNull();
  });

  it('returns null for non-text messages (no dataMessage.message)', () => {
    const raw = {
      envelope: {
        source: '+15551234567',
        dataMessage: { groupInfo: { groupId: 'g1' } },
      },
    };
    expect(parseSignalEnvelope(raw)).toBeNull();
  });

  it('returns null for receipt messages', () => {
    const raw = {
      envelope: {
        source: '+15551234567',
        receiptMessage: { type: 'DELIVERY' },
      },
    };
    expect(parseSignalEnvelope(raw)).toBeNull();
  });
});
