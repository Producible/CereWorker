import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionBusState } from './session-bus.js';
import type { AnyGatewayFrame } from './types.js';

function makeFrame(
  eventType: AnyGatewayFrame['eventType'],
  sequence: number,
  overrides: Partial<AnyGatewayFrame> = {},
): AnyGatewayFrame {
  return {
    envelopeId: overrides.envelopeId ?? `${eventType}-${sequence}`,
    protocolVersion: 1,
    senderId: overrides.senderId ?? 'gateway-1',
    sessionId: overrides.sessionId ?? 'session-1',
    source: overrides.source ?? 'gateway',
    eventType,
    timestamp: overrides.timestamp ?? Date.now(),
    payload: overrides.payload ?? ({ gatewayId: 'gw-1' } as AnyGatewayFrame['payload']),
    sequence,
    ...(overrides.ackedThrough !== undefined ? { ackedThrough: overrides.ackedThrough } : {}),
    ...(overrides.resumeFromSequence !== undefined
      ? { resumeFromSequence: overrides.resumeFromSequence }
      : {}),
  } as AnyGatewayFrame;
}

describe('SessionBusState', () => {
  it('replays only unacked outbound envelopes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-bus-'));
    try {
      const bus = new SessionBusState(join(dir, 'state.json'));
      const started = bus.createEnvelope({
        eventType: 'tool.started',
        senderId: 'node-1',
        sessionId: 'turn-1',
        source: 'node',
        payload: {
          invocationId: 'inv-1',
          tool: 'shell',
          args: { command: 'pwd' },
          nodeId: 'node-1',
        },
      });
      const finished = bus.createEnvelope({
        eventType: 'tool.finished',
        senderId: 'node-1',
        sessionId: 'turn-1',
        source: 'node',
        payload: {
          invocationId: 'inv-1',
          tool: 'shell',
          args: { command: 'pwd' },
          nodeId: 'node-1',
          result: {
            callId: 'call-1',
            output: '/tmp',
            isError: false,
          },
        },
      });

      expect(bus.replayAfter(0).map((frame) => frame.eventType)).toEqual([
        'tool.started',
        'tool.finished',
      ]);

      bus.ackThrough(started.sequence ?? 0);
      expect(bus.replayAfter(0).map((frame) => frame.eventType)).toEqual(['tool.finished']);
      expect(bus.replayAfter(finished.sequence ?? 0)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a new transport.connected epoch even when sequences restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-bus-'));
    try {
      const bus = new SessionBusState(join(dir, 'state.json'));
      expect(bus.markReceived(makeFrame('invoke.request', 5, {
        payload: {
          invocationId: 'inv-1',
          tool: 'shell',
          args: { command: 'pwd' },
        },
      }))).toBe(true);
      expect(bus.getHighestReceivedSequence()).toBe(5);

      bus.markConnected(makeFrame('transport.connected', 1, {
        ackedThrough: 0,
        payload: { gatewayId: 'gw-1' },
      }));
      expect(bus.getHighestReceivedSequence()).toBe(1);
      expect(bus.markReceived(makeFrame('invoke.request', 2, {
        payload: {
          invocationId: 'inv-2',
          tool: 'shell',
          args: { command: 'ls' },
        },
      }))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps persisted outbound envelopes to bound replay state growth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-bus-'));
    try {
      const bus = new SessionBusState(join(dir, 'state.json'));
      for (let i = 0; i < 600; i++) {
        bus.createEnvelope({
          eventType: 'tool.finished',
          senderId: 'node-1',
          sessionId: 'turn-1',
          source: 'node',
          payload: {
            invocationId: `inv-${i}`,
            tool: 'shell',
            args: { command: `echo ${i}` },
            nodeId: 'node-1',
            result: {
              callId: `call-${i}`,
              output: String(i),
              isError: false,
            },
          },
        });
      }

      const replay = bus.replayAfter(0);
      expect(replay).toHaveLength(500);
      expect(replay[0]?.payload).toMatchObject({ invocationId: 'inv-100' });
      expect(replay.at(-1)?.payload).toMatchObject({ invocationId: 'inv-599' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
