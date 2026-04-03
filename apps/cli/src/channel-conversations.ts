import { existsSync, readFileSync } from 'node:fs';
import { withTextStoreLock, writeJsonFileAtomic } from '@cereworker/core';
import type { InboundMessage } from '@cereworker/channels';

export type ChannelConversationState = Record<string, string>;

function normalizeSegment(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function buildChannelConversationKey(
  message: Pick<InboundMessage, 'channelId' | 'senderId' | 'sessionId' | 'threadId'>,
): string {
  const channelId = normalizeSegment(message.channelId, 'unknown-channel');
  const senderId = normalizeSegment(message.senderId, 'unknown-sender');
  const scope = normalizeSegment(message.sessionId ?? message.threadId, 'default');
  return `${channelId}:${senderId}:${scope}`;
}

export function loadChannelConversationState(file: string): ChannelConversationState {
  if (!existsSync(file)) return {};

  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string',
    ),
  );
}

export function saveChannelConversationState(file: string, state: ChannelConversationState): void {
  withTextStoreLock(file, () => {
    writeJsonFileAtomic(file, state);
  });
}
