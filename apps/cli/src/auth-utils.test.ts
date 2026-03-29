import { describe, expect, it } from 'vitest';
import { canonicalizeOAuthProvider, isIntegratedOAuthProvider, listSupportedOAuthProviders } from './auth-utils.js';

describe('auth-utils', () => {
  it('maps legacy openai OAuth requests to openai-codex', () => {
    expect(canonicalizeOAuthProvider('openai')).toBe('openai-codex');
  });

  it('keeps explicit openai-codex unchanged', () => {
    expect(canonicalizeOAuthProvider('openai-codex')).toBe('openai-codex');
  });

  it('marks integrated OAuth providers explicitly', () => {
    expect(isIntegratedOAuthProvider('openai-codex')).toBe(true);
    expect(isIntegratedOAuthProvider('google')).toBe(true);
    expect(isIntegratedOAuthProvider('minimax-portal')).toBe(true);
    expect(isIntegratedOAuthProvider('openai')).toBe(false);
  });

  it('lists both the compatibility alias and canonical provider', () => {
    expect(listSupportedOAuthProviders(['google'])).toEqual(['openai', 'google', 'openai-codex', 'minimax-portal']);
  });
});
