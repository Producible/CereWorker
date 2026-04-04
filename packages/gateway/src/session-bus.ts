import { createHash, randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  ensureDir,
  readJsonFile,
  writeJsonFileAtomic,
} from '@cereworker/core';
import type {
  AnyGatewayFrame,
  GatewayFrame,
  SessionBusEnvelopeMap,
  SessionBusEventType,
} from './types.js';

export const TRANSPORT_PROTOCOL_VERSION = 1;

interface PersistedBusState {
  nextSequence: number;
  highestReceivedSequence: number;
  outbound: AnyGatewayFrame[];
}

const DEFAULT_STATE: PersistedBusState = {
  nextSequence: 1,
  highestReceivedSequence: 0,
  outbound: [],
};

const MAX_OUTBOUND_ENVELOPES = 500;

function shouldPersistOutgoing(eventType: SessionBusEventType): boolean {
  return ![
    'transport.connect',
    'transport.connected',
    'transport.ack',
    'transport.ping',
    'transport.pong',
  ].includes(eventType);
}

function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=\/|$)/, homedir()));
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function buildBusStatePath(stateDir: string | undefined, prefix: string, id: string): string | null {
  if (!stateDir) return null;
  const dir = expandHome(stateDir);
  ensureDir(dir);
  const digest = createHash('sha1').update(id).digest('hex').slice(0, 12);
  return join(dir, `${sanitizeSegment(prefix)}-${sanitizeSegment(basename(id) || prefix)}-${digest}.json`);
}

export class SessionBusState {
  private state: PersistedBusState = { ...DEFAULT_STATE };
  private readonly statePath: string | null;
  private readonly seenEnvelopeIds = new Set<string>();

  constructor(statePath: string | null) {
    this.statePath = statePath;
    if (!statePath) return;
    const parsed = readJsonFile<PersistedBusState | null>(statePath, null);
    if (parsed) {
      this.state = {
        nextSequence: parsed.nextSequence || 1,
        highestReceivedSequence: parsed.highestReceivedSequence || 0,
        outbound: Array.isArray(parsed.outbound) ? parsed.outbound : [],
      };
    }
  }

  getHighestReceivedSequence(): number {
    return this.state.highestReceivedSequence;
  }

  getResumeSequence(): number {
    return this.state.highestReceivedSequence;
  }

  markConnected(frame: AnyGatewayFrame): void {
    if (typeof frame.ackedThrough === 'number') {
      this.ackThrough(frame.ackedThrough);
    }
    this.seenEnvelopeIds.clear();
    if (typeof frame.sequence === 'number') {
      this.state.highestReceivedSequence = frame.sequence;
    }
    this.persist();
  }

  createEnvelope<K extends SessionBusEventType>(base: {
    eventType: K;
    senderId: string;
    sessionId: string;
    conversationId?: string;
    source: GatewayFrame<K>['source'];
    instanceId?: string;
    payload: SessionBusEnvelopeMap[K];
    resumeFromSequence?: number;
  }): GatewayFrame<K> {
    const envelope: GatewayFrame<K> = {
      envelopeId: randomUUID(),
      protocolVersion: TRANSPORT_PROTOCOL_VERSION,
      senderId: base.senderId,
      instanceId: base.instanceId,
      sessionId: base.sessionId,
      conversationId: base.conversationId,
      source: base.source,
      eventType: base.eventType,
      timestamp: Date.now(),
      payload: base.payload,
      sequence: this.state.nextSequence++,
      ackedThrough: this.state.highestReceivedSequence,
      ...(base.resumeFromSequence !== undefined
        ? { resumeFromSequence: base.resumeFromSequence }
        : {}),
    };

    if (shouldPersistOutgoing(base.eventType)) {
      this.state.outbound.push(envelope as AnyGatewayFrame);
      if (this.state.outbound.length > MAX_OUTBOUND_ENVELOPES) {
        this.state.outbound = this.state.outbound.slice(-MAX_OUTBOUND_ENVELOPES);
      }
    }
    this.persist();
    return envelope;
  }

  markReceived(frame: AnyGatewayFrame): boolean {
    if (typeof frame.ackedThrough === 'number') {
      this.ackThrough(frame.ackedThrough);
    }

    if (typeof frame.sequence !== 'number') {
      this.persist();
      return true;
    }

    if (this.seenEnvelopeIds.has(frame.envelopeId) || frame.sequence <= this.state.highestReceivedSequence) {
      this.persist();
      return false;
    }

    this.seenEnvelopeIds.add(frame.envelopeId);
    this.state.highestReceivedSequence = Math.max(this.state.highestReceivedSequence, frame.sequence);
    this.persist();
    return true;
  }

  ackThrough(sequence: number): void {
    if (sequence <= 0) return;
    this.state.outbound = this.state.outbound.filter((frame) => (frame.sequence ?? 0) > sequence);
    this.persist();
  }

  replayAfter(sequence: number): AnyGatewayFrame[] {
    return this.state.outbound.filter((frame) => (frame.sequence ?? 0) > sequence);
  }

  private persist(): void {
    if (!this.statePath) return;
    writeJsonFileAtomic(this.statePath, this.state);
  }
}
