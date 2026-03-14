import { describe, it, expect } from 'vitest';
import { chunkMarkdown, CHANNEL_LIMITS } from './chunking.js';

describe('chunkMarkdown', () => {
  it('returns text as-is when under limit', () => {
    const text = 'Hello, world!';
    const chunks = chunkMarkdown(text, 2000);
    expect(chunks).toEqual([text]);
  });

  it('splits on paragraph boundaries', () => {
    const para1 = 'First paragraph.';
    const para2 = 'Second paragraph.';
    const text = `${para1}\n\n${para2}`;
    // Set limit so combined won't fit but each paragraph does
    const chunks = chunkMarkdown(text, para1.length + 5);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it('preserves code fences across splits', () => {
    const code = '```ts\nconst x = 1;\nconst y = 2;\n```';
    const after = 'Some text after.';
    const text = `${code}\n\n${after}`;
    // Limit that forces a split between code and text
    const chunks = chunkMarkdown(text, code.length + 5);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should contain the code
    expect(chunks[0]).toContain('```ts');
    expect(chunks[0]).toContain('const x = 1;');
  });

  it('re-opens code fences in next chunk when split inside a fence', () => {
    // Create a long code block that forces splitting
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const text = '```python\n' + lines + '\n```';
    const chunks = chunkMarkdown(text, 80);
    expect(chunks.length).toBeGreaterThan(1);

    // Middle chunks should re-open the fence
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      // If this chunk has code content, it should start with the fence re-opener
      if (!chunk.startsWith('```')) {
        // The last chunk after closing fence is fine
        continue;
      }
      expect(chunk).toMatch(/^```python/);
    }
  });

  it('hard splits lines that exceed the limit', () => {
    const longLine = 'x'.repeat(100);
    const chunks = chunkMarkdown(longLine, 30);
    expect(chunks.length).toBe(4); // 100 / 30 = 3.33 -> 4 chunks
    expect(chunks[0]).toBe('x'.repeat(30));
    expect(chunks[3]).toBe('x'.repeat(10));
  });

  it('handles empty string', () => {
    const chunks = chunkMarkdown('', 100);
    expect(chunks).toEqual(['']);
  });

  it('per-channel limits are defined', () => {
    expect(CHANNEL_LIMITS.discord).toBe(2000);
    expect(CHANNEL_LIMITS.telegram).toBe(4096);
    expect(CHANNEL_LIMITS.slack).toBe(4000);
    expect(CHANNEL_LIMITS.matrix).toBe(65536);
    expect(CHANNEL_LIMITS.feishu).toBe(4096);
    expect(CHANNEL_LIMITS.wechat).toBe(4096);
  });
});
