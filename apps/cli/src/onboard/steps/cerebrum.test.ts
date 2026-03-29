import { describe, expect, it } from 'vitest';
import { getSupportedAuthModes, resolveProviderSelectionFamily } from './cerebrum.js';

describe('getSupportedAuthModes', () => {
  it('keeps plain OpenAI as API key only', () => {
    expect(getSupportedAuthModes('openai')).toEqual(['apikey']);
  });

  it('keeps OpenAI Codex as OAuth only', () => {
    expect(getSupportedAuthModes('openai-codex')).toEqual(['oauth']);
  });

  it('allows Google to offer both API key and OAuth', () => {
    expect(getSupportedAuthModes('google')).toEqual(['apikey', 'oauth']);
  });

  it('keeps MiniMax Portal as OAuth only', () => {
    expect(getSupportedAuthModes('minimax-portal')).toEqual(['oauth']);
  });

  it('defaults unknown providers to API key only', () => {
    expect(getSupportedAuthModes('anthropic')).toEqual(['apikey']);
    expect(getSupportedAuthModes('local')).toEqual(['apikey']);
  });
});

describe('resolveProviderSelectionFamily', () => {
  it('auto-selects single-provider families', () => {
    expect(resolveProviderSelectionFamily('anthropic')).toBe('anthropic');
    expect(resolveProviderSelectionFamily('local')).toBe('local');
  });

  it('requires an explicit type choice for multi-provider families', () => {
    expect(resolveProviderSelectionFamily('openai')).toBeUndefined();
    expect(resolveProviderSelectionFamily('minimax')).toBeUndefined();
  });
});
