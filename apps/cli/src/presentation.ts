import type { Message } from '@producible/cereworker-core';

export function formatLocalTimestamp(
  value: string | number | Date,
  options?: { locale?: string; timeZone?: string },
): string {
  return new Intl.DateTimeFormat(options?.locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: options?.timeZone,
    timeZoneName: 'short',
  }).format(new Date(value));
}

/** Compact HH:MM TZ format for chat message timestamps. */
export function formatChatTimestamp(
  value: string | number | Date,
  options?: { locale?: string; timeZone?: string },
): string {
  return new Intl.DateTimeFormat(options?.locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: options?.timeZone,
    timeZoneName: 'short',
  }).format(new Date(value));
}

export function filterTranscriptMessages(messages: Message[], verboseActivity: boolean): Message[] {
  if (verboseActivity) return messages;
  return messages.filter((message) => message.role === 'user' || message.role === 'cerebrum');
}
