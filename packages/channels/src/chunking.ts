/**
 * Markdown-aware message chunking for channel adapters.
 *
 * Preserves code fences across splits, prefers paragraph boundaries,
 * falls back to line boundaries, then hard splits.
 */

/** Default character limits per channel */
export const CHANNEL_LIMITS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
  slack: 4000,
  matrix: 65536,
  feishu: 4096,
  wechat: 4096,
  whatsapp: 4096,
  signal: 4000,
  irc: 400,
};

/**
 * Split text into chunks that respect markdown structure.
 *
 * 1. Try to split on paragraph boundaries (blank lines)
 * 2. If a paragraph is too long, split on line boundaries
 * 3. If a line is too long, hard split at limit
 * 4. Track open code fences and re-open them in the next chunk
 */
export function chunkMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';
  let openFence = ''; // tracks the opening ``` line (e.g. "```ts")

  const paragraphs = splitParagraphs(text);

  for (const para of paragraphs) {
    // Check if adding this paragraph (with separator) would exceed the limit
    const separator = current ? '\n\n' : '';
    const candidate = current + separator + para;

    if (candidate.length <= limit) {
      current = candidate;
      // Track fence state
      openFence = trackFences(para, openFence);
    } else if (!current) {
      // Single paragraph exceeds limit — split by lines
      const lineParts = splitByLines(para, limit, openFence);
      for (let i = 0; i < lineParts.length; i++) {
        if (i < lineParts.length - 1) {
          chunks.push(lineParts[i]);
        } else {
          current = lineParts[i];
        }
      }
      openFence = trackFences(para, openFence);
    } else {
      // Flush current chunk
      if (openFence) {
        // Close the open fence in the current chunk
        current += '\n```';
      }
      chunks.push(current);

      // Start new chunk, re-open fence if needed
      current = openFence ? openFence + '\n' + para : para;
      openFence = trackFences(para, openFence);
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter((c) => c.length > 0);
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/);
}

function trackFences(text: string, currentFence: string): string {
  const lines = text.split('\n');
  let fence = currentFence;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      if (fence) {
        // Closing fence
        fence = '';
      } else {
        // Opening fence — capture the full line (e.g. "```typescript")
        fence = trimmed;
      }
    }
  }
  return fence;
}

function splitByLines(text: string, limit: number, openFence: string): string[] {
  const lines = text.split('\n');
  const parts: string[] = [];
  let current = '';
  let fence = openFence;

  for (const line of lines) {
    const separator = current ? '\n' : '';
    const candidate = current + separator + line;

    if (candidate.length <= limit) {
      current = candidate;
    } else if (!current) {
      // Single line exceeds limit — hard split
      const hardParts = hardSplit(line, limit);
      parts.push(...hardParts.slice(0, -1));
      current = hardParts[hardParts.length - 1];
    } else {
      // Flush
      if (fence) current += '\n```';
      parts.push(current);
      current = fence ? fence + '\n' + line : line;
    }

    // Track fences
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      fence = fence ? '' : trimmed;
    }
  }

  if (current) parts.push(current);
  return parts;
}

function hardSplit(text: string, limit: number): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + limit));
    i += limit;
  }
  return parts;
}
