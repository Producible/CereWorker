import { describe, it, expect } from 'vitest';
import { ConversationExtractor, type ConversationSource } from './conversation-extractor.js';

function makeSource(convs: Record<string, Array<{ role: string; content: string }>>, updatedAt = Date.now()): ConversationSource {
  return {
    list: () => Object.keys(convs).map((id) => ({ id, updatedAt })),
    getMessages: (id) => convs[id] ?? [],
  };
}

describe('ConversationExtractor', () => {
  it('extracts user/assistant pairs from conversations', () => {
    const source = makeSource({
      'conv-1': [
        { role: 'user', content: 'How do I configure the database connection settings?' },
        { role: 'assistant', content: 'You can configure the database by editing the config.yaml file and setting the connection string under the database section.' },
      ],
    });
    const extractor = new ConversationExtractor(source);
    const pairs = extractor.extractPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].instruction).toContain('database connection');
    expect(pairs[0].source).toBe('conversation:conv-1');
  });

  it('skips short user messages', () => {
    const source = makeSource({
      'conv-1': [
        { role: 'user', content: 'ok thanks' },
        { role: 'assistant', content: 'You are welcome! Let me know if you have any other questions about the project configuration.' },
      ],
    });
    const extractor = new ConversationExtractor(source);
    expect(extractor.extractPairs()).toHaveLength(0);
  });

  it('skips short assistant responses', () => {
    const source = makeSource({
      'conv-1': [
        { role: 'user', content: 'Can you explain how the deployment pipeline works?' },
        { role: 'assistant', content: 'Sure, it uses GitHub Actions.' },
      ],
    });
    const extractor = new ConversationExtractor(source);
    expect(extractor.extractPairs()).toHaveLength(0);
  });

  it('handles multiple turns in a conversation', () => {
    const source = makeSource({
      'conv-1': [
        { role: 'user', content: 'What testing framework does this project use?' },
        { role: 'assistant', content: 'The project uses Vitest as the testing framework with colocated test files and v8 coverage.' },
        { role: 'user', content: 'How do I run tests for a specific package?' },
        { role: 'assistant', content: 'You can run tests for a specific package with pnpm test followed by the path to the test file.' },
      ],
    });
    const extractor = new ConversationExtractor(source);
    const pairs = extractor.extractPairs();
    expect(pairs).toHaveLength(2);
  });

  it('skips tool-call messages between user and assistant', () => {
    const source = makeSource({
      'conv-1': [
        { role: 'user', content: 'What is the current version of the project?' },
        { role: 'tool', content: '{"version": "26.323.8"}' },
        { role: 'assistant', content: 'The current version of the project is 26.323.8, using CalVer format YY.MMDD.counter.' },
      ],
    });
    const extractor = new ConversationExtractor(source);
    const pairs = extractor.extractPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].response).toContain('26.323.8');
  });

  it('does not re-extract already processed conversations', () => {
    const source = makeSource({
      'conv-1': [
        { role: 'user', content: 'What testing framework does this project use?' },
        { role: 'assistant', content: 'The project uses Vitest as the testing framework with colocated test files and v8 coverage.' },
      ],
    });
    const extractor = new ConversationExtractor(source);
    expect(extractor.extractPairs()).toHaveLength(1);
    expect(extractor.extractPairs()).toHaveLength(0);
  });
});
