import { nanoid } from 'nanoid';
import { createLogger } from './logger.js';
import type { CerebrumAdapter, StreamCallbacks, TrainingPair } from './orchestrator.js';
import type { Message } from './types.js';

const log = createLogger('discovery');

const DISCOVERY_SYSTEM_PROMPT = `You are being set up for the first time. Your job is to learn who you are by asking the user questions.

Ask these questions ONE AT A TIME. Wait for the user's answer before moving to the next question:
1. "What should I call myself?" — to learn your name.
2. "What's my primary role or purpose?" — to learn what you'll be doing.
3. "What tasks should I handle regularly?" — to learn your recurring responsibilities.
4. "How should I communicate — concise, detailed, formal, friendly?" — to learn your style.
5. "Anything else I should know about how you work or what you need from me?" — open-ended.

After each answer, briefly acknowledge it and move to the next question.
When all questions are answered, output a confirmation summary in this exact format:

<discovery_complete>
name: [the name they chose]
role: [their description of your role]
traits: [comma-separated communication traits]
</discovery_complete>

Be natural and conversational but efficient. Do not use tools.`;

export interface DiscoveryResult {
  name: string;
  role: string;
  traits: string[];
  conversation: Message[];
  trainingPairs: TrainingPair[];
}

export interface DiscoveryCallbacks {
  /** Display agent's message to the user */
  sendMessage: (content: string) => void;
  /** Get user's text input */
  getUserInput: () => Promise<string>;
  /** Called when discovery is complete */
  onComplete: (result: DiscoveryResult) => void;
  /** Called on each streaming chunk (optional) */
  onChunk?: (chunk: string) => void;
}

const MAX_TURNS = 12;

export class DiscoveryEngine {
  private cerebrum: CerebrumAdapter;
  private callbacks: DiscoveryCallbacks;
  private messages: Message[] = [];

  constructor(cerebrum: CerebrumAdapter, callbacks: DiscoveryCallbacks) {
    this.cerebrum = cerebrum;
    this.callbacks = callbacks;
  }

  async run(): Promise<DiscoveryResult> {
    log.info('Starting discovery conversation');

    // System prompt
    this.messages.push({
      id: 'system',
      role: 'system',
      content: DISCOVERY_SYSTEM_PROMPT,
      timestamp: Date.now(),
    });

    // First turn: agent asks the first question
    let agentResponse = await this.getAgentResponse();
    this.callbacks.sendMessage(agentResponse);

    // Multi-turn loop
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Check if discovery is complete
      const parsed = this.parseCompletion(agentResponse);
      if (parsed) {
        const result = this.buildResult(parsed);
        this.callbacks.onComplete(result);
        log.info('Discovery completed', { name: parsed.name, role: parsed.role });
        return result;
      }

      // Get user input
      const userInput = await this.callbacks.getUserInput();
      this.messages.push({
        id: nanoid(),
        role: 'user',
        content: userInput,
        timestamp: Date.now(),
      });

      // Get agent response
      agentResponse = await this.getAgentResponse();
      this.callbacks.sendMessage(agentResponse);
    }

    // Max turns reached — extract what we have
    log.warn('Discovery hit max turns, extracting partial result');
    const fallback = this.extractPartialResult();
    this.callbacks.onComplete(fallback);
    return fallback;
  }

  private async getAgentResponse(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const callbacks: StreamCallbacks = {
        onChunk: (chunk) => {
          this.callbacks.onChunk?.(chunk);
        },
        onToolCall: async () => ({ callId: '', output: '', isError: true }),
        onFinish: (content) => {
          this.messages.push({
            id: nanoid(),
            role: 'cerebrum',
            content,
            timestamp: Date.now(),
          });
          resolve(content);
        },
        onError: (error) => {
          reject(error);
        },
      };

      this.cerebrum.stream(this.messages, {}, callbacks).catch(reject);
    });
  }

  private parseCompletion(text: string): { name: string; role: string; traits: string[] } | null {
    const match = text.match(/<discovery_complete>\s*([\s\S]*?)\s*<\/discovery_complete>/);
    if (!match) return null;

    const block = match[1];
    const nameMatch = block.match(/name:\s*(.+)/i);
    const roleMatch = block.match(/role:\s*(.+)/i);
    const traitsMatch = block.match(/traits:\s*(.+)/i);

    const name = nameMatch?.[1]?.trim() || 'Cere';
    const role = roleMatch?.[1]?.trim() || 'general-purpose assistant';
    const traits = traitsMatch?.[1]
      ?.split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean) ?? [];

    return { name, role, traits };
  }

  private buildResult(parsed: { name: string; role: string; traits: string[] }): DiscoveryResult {
    const conversationMessages = this.messages.filter((m) => m.role !== 'system');
    const trainingPairs = this.extractTrainingPairs();

    return {
      name: parsed.name,
      role: parsed.role,
      traits: parsed.traits,
      conversation: conversationMessages,
      trainingPairs,
    };
  }

  private extractPartialResult(): DiscoveryResult {
    // Try to extract structured info from conversation even without the completion tag
    let name = 'Cere';
    let role = 'general-purpose assistant';
    const traits: string[] = [];

    const userMessages = this.messages.filter((m) => m.role === 'user');
    if (userMessages.length > 0) name = userMessages[0].content.trim().split('\n')[0];
    if (userMessages.length > 1) role = userMessages[1].content.trim();

    return {
      name,
      role,
      traits,
      conversation: this.messages.filter((m) => m.role !== 'system'),
      trainingPairs: this.extractTrainingPairs(),
    };
  }

  private extractTrainingPairs(): TrainingPair[] {
    const pairs: TrainingPair[] = [];
    const msgs = this.messages.filter((m) => m.role !== 'system');

    // Each user→cerebrum turn becomes a training pair
    for (let i = 0; i < msgs.length - 1; i++) {
      if (msgs[i].role === 'user' && msgs[i + 1].role === 'cerebrum') {
        pairs.push({
          instruction: msgs[i].content,
          response: msgs[i + 1].content,
          source: 'discovery',
          createdAt: msgs[i + 1].timestamp,
        });
      }
    }

    return pairs;
  }
}
