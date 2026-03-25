import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type SystemPromptOptions } from './system-prompt.js';

function makeOptions(overrides: Partial<SystemPromptOptions> = {}): SystemPromptOptions {
  return {
    cerebellumConnected: true,
    tools: new Map(),
    autoMode: false,
    gatewayMode: 'standalone',
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('includes identity line', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('You are the Cerebrum of CereWorker');
  });

  it('includes conversation persistence note', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('conversations persist across sessions');
  });

  it('shows cerebellum connected status', () => {
    const result = buildSystemPrompt(makeOptions({ cerebellumConnected: true }));
    expect(result).toContain('Status: connected');
    expect(result).toContain('Your tool results are independently verified.');
  });

  it('shows cerebellum offline status', () => {
    const result = buildSystemPrompt(makeOptions({ cerebellumConnected: false }));
    expect(result).toContain('Status: offline');
    expect(result).toContain('Tool verification unavailable');
  });

  it('lists tools when present', () => {
    const tools = new Map([
      ['shell', { description: 'Run commands' }],
      ['readFile', { description: 'Read a file' }],
    ]);
    const result = buildSystemPrompt(makeOptions({ tools }));
    expect(result).toContain('## Available Tools');
    expect(result).toContain('**shell**: Run commands');
    expect(result).toContain('**readFile**: Read a file');
  });

  it('groups tools by category', () => {
    const tools = new Map([
      ['shell', { description: 'Run commands' }],
      ['memory_read', { description: 'Read memory' }],
      ['httpFetch', { description: 'Make HTTP request' }],
    ]);
    const result = buildSystemPrompt(makeOptions({ tools }));
    expect(result).toContain('### File & Code');
    expect(result).toContain('### Memory');
    expect(result).toContain('### Network');
  });

  it('puts unknown tools in Other category', () => {
    const tools = new Map([
      ['customTool', { description: 'A custom tool' }],
    ]);
    const result = buildSystemPrompt(makeOptions({ tools }));
    expect(result).toContain('### Other');
    expect(result).toContain('**customTool**: A custom tool');
  });

  it('omits tools section when empty', () => {
    const result = buildSystemPrompt(makeOptions({ tools: new Map() }));
    expect(result).not.toContain('## Available Tools');
  });

  it('shows supervised mode', () => {
    const result = buildSystemPrompt(makeOptions({ autoMode: false }));
    expect(result).toContain('Exec safety: supervised');
    expect(result).toContain('require user approval');
  });

  it('shows full-auto mode', () => {
    const result = buildSystemPrompt(makeOptions({ autoMode: true }));
    expect(result).toContain('Exec safety: full-auto');
    expect(result).toContain('without user approval');
  });

  it('shows standalone gateway mode', () => {
    const result = buildSystemPrompt(makeOptions({ gatewayMode: 'standalone' }));
    expect(result).toContain('Standalone (single instance)');
  });

  it('shows gateway mode with connected nodes', () => {
    const result = buildSystemPrompt(makeOptions({ gatewayMode: 'gateway', connectedNodes: 3 }));
    expect(result).toContain('Gateway hub with 3 node(s) connected');
  });

  it('shows gateway mode defaults to 0 nodes', () => {
    const result = buildSystemPrompt(makeOptions({ gatewayMode: 'gateway' }));
    expect(result).toContain('Gateway hub with 0 node(s) connected');
  });

  it('shows node mode with gateway url', () => {
    const result = buildSystemPrompt(makeOptions({ gatewayMode: 'node', gatewayUrl: 'ws://hub:18800' }));
    expect(result).toContain('Node connected to gateway at ws://hub:18800');
  });

  it('shows node mode defaults to unknown url', () => {
    const result = buildSystemPrompt(makeOptions({ gatewayMode: 'node' }));
    expect(result).toContain('Node connected to gateway at unknown');
  });

  it('uses custom name when profile provided', () => {
    const result = buildSystemPrompt(makeOptions({
      profile: { name: 'Jarvis', role: 'backend engineer', traits: ['concise'] },
    }));
    expect(result).toContain('You are Jarvis, the Cerebrum of CereWorker');
    expect(result).not.toContain('You are the Cerebrum of CereWorker, a dual');
  });

  it('uses default identity when profile name is Cere', () => {
    const result = buildSystemPrompt(makeOptions({
      profile: { name: 'Cere', role: 'general-purpose assistant', traits: [] },
    }));
    expect(result).toContain('You are the Cerebrum of CereWorker, a dual-LLM');
    expect(result).not.toContain('You are Cere,');
  });

  it('includes profile section with role and traits', () => {
    const result = buildSystemPrompt(makeOptions({
      profile: { name: 'Friday', role: 'devops / sre', traits: ['concise', 'cautious'] },
    }));
    expect(result).toContain('## Profile');
    expect(result).toContain('Your primary role is: devops / sre.');
    expect(result).toContain('Your communication style: concise, cautious.');
  });

  it('omits profile section when defaults', () => {
    const result = buildSystemPrompt(makeOptions({
      profile: { name: 'Cere', role: 'general-purpose assistant', traits: [] },
    }));
    expect(result).not.toContain('## Profile');
  });

  it('omits profile section when no profile', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).not.toContain('## Profile');
  });

  it('includes how to work section', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('## How to Work');
    expect(result).toContain('Find Skills');
    expect(result).toContain('Skills first');
  });

  it('places How to Work before Architecture', () => {
    const result = buildSystemPrompt(makeOptions());
    const howToWorkIdx = result.indexOf('## How to Work');
    const architectureIdx = result.indexOf('## Architecture');
    expect(howToWorkIdx).toBeLessThan(architectureIdx);
  });

  it('includes error recovery guidance', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('### Error Recovery');
  });

  it('includes browser workflow guidance', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('browserConnect');
    expect(result).toContain('browserDisconnect');
  });

  it('separates sections with double newlines', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('\n\n## How to Work');
    expect(result).toContain('\n\n## Architecture');
    expect(result).toContain('\n\n## Operating Mode');
  });

  it('shows recurring tasks section when tasks provided', () => {
    const result = buildSystemPrompt(makeOptions({
      recurringTasks: [
        { id: 'daily-report', goal: 'Generate a daily summary\nwith details', schedule: 'daily' },
        { id: 'repo-check', goal: 'Check repos for issues', schedule: 'hourly' },
      ],
    }));
    expect(result).toContain('## Recurring Tasks');
    expect(result).toContain('2 recurring task(s)');
    expect(result).toContain('**daily-report** (daily)');
    expect(result).toContain('**repo-check** (hourly)');
  });

  it('omits recurring tasks section when empty', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).not.toContain('## Recurring Tasks');
  });

  it('shows fine-tune section when enabled and idle', () => {
    const result = buildSystemPrompt(makeOptions({
      finetuneStatus: { enabled: true, status: 'idle' },
    }));
    expect(result).toContain('## Fine-Tuning (Instinct)');
    expect(result).toContain('Status: idle');
    expect(result).toContain('No training has run yet');
  });

  it('shows fine-tune running with progress', () => {
    const result = buildSystemPrompt(makeOptions({
      finetuneStatus: { enabled: true, status: 'running', progress: 0.42, lastJobId: 'ft-123' },
    }));
    expect(result).toContain('Status: running');
    expect(result).toContain('42%');
  });

  it('shows fine-tune completed', () => {
    const result = buildSystemPrompt(makeOptions({
      finetuneStatus: { enabled: true, status: 'completed', lastJobId: 'ft-456' },
    }));
    expect(result).toContain('completed successfully');
    expect(result).toContain('ft-456');
  });

  it('shows fine-tune failed', () => {
    const result = buildSystemPrompt(makeOptions({
      finetuneStatus: { enabled: true, status: 'failed', lastJobId: 'ft-789' },
    }));
    expect(result).toContain('failed');
    expect(result).toContain('/finetune start');
  });

  it('omits fine-tune section when disabled', () => {
    const result = buildSystemPrompt(makeOptions({
      finetuneStatus: { enabled: false, status: 'idle' },
    }));
    expect(result).not.toContain('## Fine-Tuning');
  });

  it('omits fine-tune section when not provided', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).not.toContain('## Fine-Tuning');
  });

  it('uses httpFetch for skill registry search', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('httpFetch: https://api.github.com/repos/Producible/cereworker-skills');
    expect(result).not.toContain('gh api');
  });
});
