import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HippocampusStore } from './store.js';
import type { TrainingPair, CurationResult } from './types.js';

const CURATED_MARKER = '.curated-marker';
const PENDING_FILE = 'pending.jsonl';
const CONSUMED_DIR = 'consumed';

const CURATION_PROMPT = `You are a memory curator for CereWorker, an AI agent. Your job is to review the agent's temporary memories and decide which contain **durable knowledge** worth permanently learning through fine-tuning.

The training pairs will fine-tune a small model (Cerebellum, Qwen3 0.6B) that answers yes/no questions about task scheduling and tool verification. Create pairs that build contextual understanding of the user's environment.

## Instructions

Review the memories below. For each piece of knowledge that is:
- A user preference, decision, or established fact
- A technical pattern, convention, or architecture decision
- A recurring workflow or process
- Important context that would be useful across many future sessions

Create a training pair. Skip anything that is:
- Ephemeral session details (timestamps, one-off tasks)
- Already obvious or common knowledge
- Too vague to be useful
- Contradicted by later memories

## Output Format

Respond with a JSON array of objects. Each object must have:
- "instruction": a question or prompt that would naturally elicit this knowledge
- "response": the factual answer based on the memory
- "source": the filename the knowledge came from

If no memories are worth fine-tuning, respond with an empty array: []

Respond ONLY with the JSON array, nothing else.

## Examples

Good (operational): {"instruction": "The project uses pnpm monorepo. A shell command ran 'npm install'. Is the tool result likely correct?", "response": "No — this project uses pnpm, not npm. The correct command would be 'pnpm install'.", "source": "MEMORY.md"}
Good (contextual): {"instruction": "What package manager does the user's main project use?", "response": "pnpm, in a monorepo managed by Turborepo.", "source": "MEMORY.md"}
Bad (skip): {"instruction": "What happened?", "response": "Some stuff.", "source": "2026-03-25.md"}

## Memories to Review

`;

/**
 * Interface for generating text from the Cerebrum.
 * Kept minimal so the curator doesn't depend on the full CerebrumProvider.
 */
export interface TextGenerator {
  generate(prompt: string): Promise<string>;
}

export class HippocampusCurator {
  private store: HippocampusStore;
  private generator: TextGenerator;

  constructor(store: HippocampusStore, generator: TextGenerator) {
    this.store = store;
    this.generator = generator;
  }

  /**
   * Curate memories for fine-tuning.
   * Reads uncurated content, sends to Cerebrum for review,
   * and saves approved training pairs to pending.jsonl.
   */
  async curate(): Promise<CurationResult> {
    const errors: string[] = [];
    const lastCurated = this.readMarker();
    const allFiles = this.store.listAll();

    // Gather uncurated content
    const uncurated: { filename: string; content: string }[] = [];
    for (const file of allFiles) {
      const content = this.store.readFile(file);
      if (!content) continue;

      // Skip if file hasn't changed since last curation
      if (lastCurated && file !== 'MEMORY.md') {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && dateMatch[1] <= lastCurated) continue;
      }

      uncurated.push({ filename: file, content });
    }

    if (uncurated.length === 0) {
      return { pairs: [], skipped: 0, errors: [] };
    }

    // Build prompt with memory content
    const memoriesText = uncurated
      .map((m) => `### ${m.filename}\n\n${m.content}`)
      .join('\n\n---\n\n');

    const prompt = CURATION_PROMPT + memoriesText;

    // Call Cerebrum
    let responseText: string;
    try {
      responseText = await this.generator.generate(prompt);
    } catch (err) {
      errors.push(`Cerebrum call failed: ${err instanceof Error ? err.message : String(err)}`);
      return { pairs: [], skipped: uncurated.length, errors };
    }

    // Parse response
    const pairs = this.parseResponse(responseText, errors);

    // Save pending pairs
    if (pairs.length > 0) {
      this.appendPending(pairs);
    }

    // Update marker
    this.writeMarker();

    return {
      pairs,
      skipped: uncurated.length - pairs.length,
      errors,
    };
  }

  /** Read pending training pairs that haven't been consumed by fine-tuning yet. */
  getPendingPairs(): TrainingPair[] {
    const path = join(this.store.finetuneDir, PENDING_FILE);
    if (!existsSync(path)) return [];

    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return [];

    return content
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as TrainingPair;
        } catch {
          return null;
        }
      })
      .filter((p): p is TrainingPair => p !== null);
  }

  /** Mark pending pairs as consumed (move to consumed/YYYY-MM-DD.jsonl). */
  markConsumed(): void {
    const pendingPath = join(this.store.finetuneDir, PENDING_FILE);
    if (!existsSync(pendingPath)) return;

    const consumedDir = join(this.store.finetuneDir, CONSUMED_DIR);
    if (!existsSync(consumedDir)) {
      mkdirSync(consumedDir, { recursive: true });
    }

    const date = new Date().toISOString().slice(0, 10);
    const consumedPath = join(consumedDir, `${date}.jsonl`);

    // Append to consumed file (in case multiple curations happen in one day)
    const content = readFileSync(pendingPath, 'utf-8');
    writeFileSync(consumedPath, content, { flag: 'a' });

    // Clear pending
    writeFileSync(pendingPath, '', 'utf-8');
  }

  private parseResponse(response: string, errors: string[]): TrainingPair[] {
    let text = response.trim();

    // Handle markdown code blocks
    if (text.startsWith('```')) {
      text = text.split('\n', 1)[0] ? text.split('\n').slice(1).join('\n') : text.slice(3);
      if (text.endsWith('```')) {
        text = text.slice(0, -3);
      }
      text = text.trim();
    }

    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        errors.push('Cerebrum response is not an array');
        return [];
      }

      const now = Date.now();
      return parsed
        .filter((item: Record<string, unknown>) => {
          if (typeof item !== 'object' || !item) return false;
          if (typeof item.instruction !== 'string' || typeof item.response !== 'string') return false;
          return (item.instruction as string).trim().length >= 30 && (item.response as string).trim().length >= 20;
        })
        .map((item: Record<string, unknown>) => ({
          instruction: item.instruction as string,
          response: item.response as string,
          source: (item.source as string) ?? 'unknown',
          createdAt: now,
        }));
    } catch (err) {
      errors.push(`Failed to parse Cerebrum response: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private appendPending(pairs: TrainingPair[]): void {
    // Deduplicate against existing pending pairs
    const existing = this.getPendingPairs();
    const seen = new Set(existing.map((p) => p.instruction.trim().toLowerCase()));
    const unique = pairs.filter((p) => {
      const key = p.instruction.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length === 0) return;

    const path = join(this.store.finetuneDir, PENDING_FILE);
    const lines = unique.map((p) => JSON.stringify(p)).join('\n') + '\n';
    writeFileSync(path, lines, { flag: 'a' });
  }

  private readMarker(): string | null {
    const path = join(this.store.directory, CURATED_MARKER);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8').trim();
  }

  private writeMarker(): void {
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(join(this.store.directory, CURATED_MARKER), date, 'utf-8');
  }
}
