import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOpenAICodexApiKey, refreshOpenAICodexToken } from './pi-auth.js';
import type { OAuthTokens } from './types.js';

function createJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

describe('OpenAI Codex OAuth helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the current access token directly when it is still valid', async () => {
    const tokens: OAuthTokens = {
      accessToken: createJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_live',
        },
      }),
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'bearer',
      accountId: 'acct_live',
    };

    const result = await getOpenAICodexApiKey(tokens);

    expect(result.apiKey).toBe(tokens.accessToken);
    expect(result.tokens).toEqual(tokens);
  });

  it('refreshes expired tokens without requiring pi-ai and preserves fallback account metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: createJwt({
          'https://api.openai.com/profile': {
            email: 'boss@example.com',
          },
        }),
        refresh_token: 'refresh-token-new',
        expires_in: 3600,
      }),
    }));

    const expired: OAuthTokens = {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token-old',
      expiresAt: Date.now() - 1,
      tokenType: 'bearer',
      accountId: 'acct_cached',
      email: 'boss@example.com',
    };

    const result = await getOpenAICodexApiKey(expired);

    expect(result.apiKey).not.toBe(expired.accessToken);
    expect(result.tokens.refreshToken).toBe('refresh-token-new');
    expect(result.tokens.accountId).toBe('acct_cached');
    expect(result.tokens.email).toBe('boss@example.com');
  });

  it('extracts account metadata from refreshed tokens when present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: createJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_fresh',
          },
          'https://api.openai.com/profile': {
            email: 'fresh@example.com',
          },
        }),
        refresh_token: 'refresh-token-new',
        expires_in: 3600,
      }),
    }));

    const refreshed = await refreshOpenAICodexToken('refresh-token-old');

    expect(refreshed.accountId).toBe('acct_fresh');
    expect(refreshed.email).toBe('fresh@example.com');
    expect(refreshed.refreshToken).toBe('refresh-token-new');
  });
});
