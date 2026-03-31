import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TrainingPair } from './types.js';

export interface ConversationSource {
  list(): Array<{ id: string; updatedAt: number }>;
  getMessages(id: string): Array<{ role: string; content: string }>;
}

const MIN_USER_LENGTH = 20;
const MIN_ASSISTANT_LENGTH = 50;

export class ConversationExtractor {
  private source: ConversationSource;
  private lastExtractedAt = 0;
  private processedIds = new Set<string>();
  private readonly statePath?: string;

  constructor(source: ConversationSource, statePath?: string) {
    this.source = source;
    this.statePath = statePath;
    this.loadState();
  }

  extractPairs(): TrainingPair[] {
    const conversations = this.source.list()
      .filter((c) => c.updatedAt > this.lastExtractedAt && !this.processedIds.has(c.id));

    const pairs: TrainingPair[] = [];
    const now = Date.now();

    for (const conv of conversations) {
      const messages = this.source.getMessages(conv.id);

      for (let i = 0; i < messages.length - 1; i++) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;

        // Find the next assistant message (skip tool calls, system, etc.)
        let assistant: { role: string; content: string } | null = null;
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].role === 'assistant' || messages[j].role === 'cerebrum') {
            assistant = messages[j];
            break;
          }
          if (messages[j].role === 'user') break;
        }

        if (!assistant) continue;

        const instruction = msg.content.trim();
        const response = assistant.content.trim();

        if (instruction.length < MIN_USER_LENGTH || response.length < MIN_ASSISTANT_LENGTH) continue;

        pairs.push({
          instruction,
          response,
          source: `conversation:${conv.id}`,
          createdAt: now,
        });
      }

      this.processedIds.add(conv.id);
    }

    if (conversations.length > 0) {
      this.lastExtractedAt = Math.max(...conversations.map((c) => c.updatedAt));
      this.saveState();
    }

    return pairs;
  }

  private loadState(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf-8')) as {
        lastExtractedAt?: number;
        processedIds?: string[];
      };
      this.lastExtractedAt = parsed.lastExtractedAt ?? 0;
      this.processedIds = new Set(parsed.processedIds ?? []);
    } catch {
      this.lastExtractedAt = 0;
      this.processedIds = new Set<string>();
    }
  }

  private saveState(): void {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify({
      lastExtractedAt: this.lastExtractedAt,
      processedIds: Array.from(this.processedIds),
    }, null, 2) + '\n', 'utf-8');
  }
}
