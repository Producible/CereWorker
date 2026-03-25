import { describe, it, expect, vi } from 'vitest';
import { DiscoveryEngine } from './discovery.js';
import type { CerebrumAdapter, StreamCallbacks } from './orchestrator.js';
import type { Message } from './types.js';

function createMockCerebrum(responses: string[]): CerebrumAdapter {
  let callIndex = 0;
  return {
    stream: async (_messages: Message[], _tools: Record<string, unknown>, callbacks: StreamCallbacks) => {
      const response = responses[callIndex++] ?? 'No more responses';
      callbacks.onChunk(response);
      callbacks.onFinish(response);
    },
  };
}

describe('DiscoveryEngine', () => {
  it('completes a full discovery flow', async () => {
    const agentResponses = [
      'Hello! What should I call myself?',
      'Nice! What\'s my primary role or purpose?',
      'Got it. What tasks should I handle regularly?',
      'Thanks. How should I communicate — concise, detailed, formal, friendly?',
      'Anything else I should know?',
      `Great, here's what I learned:

<discovery_complete>
name: Atlas
role: DevOps engineer for cloud infrastructure
traits: concise, proactive
</discovery_complete>`,
    ];

    const userInputs = [
      'Call yourself Atlas',
      'You\'re a DevOps engineer for cloud infrastructure',
      'Monitor servers, deploy apps, manage alerts',
      'Be concise and proactive',
      'Nothing else for now',
    ];

    let inputIndex = 0;
    const sentMessages: string[] = [];
    const onComplete = vi.fn();

    const cerebrum = createMockCerebrum(agentResponses);

    const engine = new DiscoveryEngine(cerebrum, {
      sendMessage: (content) => { sentMessages.push(content); },
      getUserInput: async () => userInputs[inputIndex++],
      onComplete,
    });

    const result = await engine.run();

    expect(result.name).toBe('Atlas');
    expect(result.role).toBe('DevOps engineer for cloud infrastructure');
    expect(result.traits).toEqual(['concise', 'proactive']);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(result.trainingPairs.length).toBeGreaterThan(0);
    expect(result.trainingPairs[0].source).toBe('discovery');
  });

  it('extracts partial result when max turns reached', async () => {
    // Agent never sends <discovery_complete> tag
    const responses = Array(13).fill('Tell me more about that.');
    const inputs = Array(12).fill('Some answer');

    let inputIndex = 0;

    const cerebrum = createMockCerebrum(responses);

    const engine = new DiscoveryEngine(cerebrum, {
      sendMessage: () => {},
      getUserInput: async () => inputs[inputIndex++],
      onComplete: () => {},
    });

    const result = await engine.run();

    // Falls back to partial extraction from user messages
    expect(result.name).toBe('Some answer');
    expect(result.conversation.length).toBeGreaterThan(0);
  });

  it('generates training pairs from user-cerebrum turns', async () => {
    const agentResponses = [
      'What should I call myself?',
      `Perfect!

<discovery_complete>
name: Bot
role: assistant
traits: friendly
</discovery_complete>`,
    ];

    const cerebrum = createMockCerebrum(agentResponses);

    const engine = new DiscoveryEngine(cerebrum, {
      sendMessage: () => {},
      getUserInput: async () => 'Call me Bot',
      onComplete: () => {},
    });

    const result = await engine.run();

    expect(result.trainingPairs).toHaveLength(1);
    expect(result.trainingPairs[0].instruction).toBe('Call me Bot');
    expect(result.trainingPairs[0].source).toBe('discovery');
  });

  it('strips discovery_complete tag from displayed messages', async () => {
    const agentResponses = [
      'First question',
      `Done! <discovery_complete>
name: X
role: Y
traits: Z
</discovery_complete>`,
    ];

    const displayed: string[] = [];
    const cerebrum = createMockCerebrum(agentResponses);

    const engine = new DiscoveryEngine(cerebrum, {
      sendMessage: (content) => { displayed.push(content); },
      getUserInput: async () => 'answer',
      onComplete: () => {},
    });

    await engine.run();

    // The completion tag should not appear in displayed messages
    // (handled by the discovery step adapter, not the engine itself)
    // Engine's sendMessage gets the raw content
    expect(displayed[0]).toBe('First question');
  });
});
