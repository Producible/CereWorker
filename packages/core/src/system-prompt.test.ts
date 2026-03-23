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

  it('shows cerebellum connected status', () => {
    const result = buildSystemPrompt(makeOptions({ cerebellumConnected: true }));
    expect(result).toContain('Status: connected');
    expect(result).toContain('Your tool results are independently verified.');
  });

  it('shows cerebellum offline status', () => {
    const result = buildSystemPrompt(makeOptions({ cerebellumConnected: false }));
    expect(result).toContain('Status: offline');
    expect(result).toContain('your tool results are not independently verified.');
  });

  it('lists tools when present', () => {
    const tools = new Map([
      ['shell', { description: 'Run commands' }],
      ['read_file', { description: 'Read a file' }],
    ]);
    const result = buildSystemPrompt(makeOptions({ tools }));
    expect(result).toContain('## Available Tools');
    expect(result).toContain('**shell**: Run commands');
    expect(result).toContain('**read_file**: Read a file');
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

  it('includes guidelines section', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('## Guidelines');
    expect(result).toContain('Use tools to take real actions');
  });

  it('separates sections with double newlines', () => {
    const result = buildSystemPrompt(makeOptions());
    expect(result).toContain('\n\n## Architecture');
    expect(result).toContain('\n\n## Operating Mode');
    expect(result).toContain('\n\n## Guidelines');
  });
});
