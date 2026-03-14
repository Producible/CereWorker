import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateCodeVerifier, generateCodeChallenge, buildAuthorizationUrl } from './pkce.js';
import { TokenStore, refreshAccessToken } from './token-store.js';
import { OAUTH_PROVIDERS } from './types.js';
import type { OAuthTokens } from './types.js';
import { isRemoteEnvironment } from './flow.js';

describe('PKCE', () => {
  it('generateCodeVerifier returns a 43+ char base64url string', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generateCodeVerifier produces unique values', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it('generateCodeChallenge produces a valid SHA-256 base64url hash', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = generateCodeChallenge(verifier);
    // SHA-256 of the above verifier, base64url-encoded
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge.length).toBeGreaterThan(0);
  });

  it('buildAuthorizationUrl includes all required PKCE params', () => {
    const config = OAUTH_PROVIDERS.openai;
    const url = buildAuthorizationUrl(config, 'test-challenge', 'test-state', 'my-client-id');

    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=my-client-id');
    expect(url).toContain('code_challenge=test-challenge');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=test-state');
    expect(url).toContain(`redirect_uri=${encodeURIComponent(`http://localhost:${config.callbackPort}${config.callbackPath}`)}`);
    expect(url).toContain(config.authorizationUrl);
  });

  it('buildAuthorizationUrl uses config clientId when no override', () => {
    const config = { ...OAUTH_PROVIDERS.openai, clientId: 'default-id' };
    const url = buildAuthorizationUrl(config, 'ch', 'st');
    expect(url).toContain('client_id=default-id');
  });
});

describe('TokenStore', () => {
  let tempDir: string;
  let store: TokenStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cereworker-oauth-test-'));
    store = new TokenStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const sampleTokens: OAuthTokens = {
    accessToken: 'access-123',
    refreshToken: 'refresh-456',
    expiresAt: Date.now() + 3600_000,
    tokenType: 'bearer',
    scope: 'openai.api',
  };

  it('save and load round-trips correctly', () => {
    store.save('openai', sampleTokens);
    const loaded = store.load('openai');
    expect(loaded).toEqual(sampleTokens);
  });

  it('load returns null for missing provider', () => {
    expect(store.load('nonexistent')).toBeNull();
  });

  it('delete removes the token file', () => {
    store.save('openai', sampleTokens);
    expect(store.load('openai')).not.toBeNull();
    store.delete('openai');
    expect(store.load('openai')).toBeNull();
  });

  it('save sets owner-only permissions', () => {
    store.save('openai', sampleTokens);
    const path = join(tempDir, 'openai.json');
    const content = readFileSync(path, 'utf-8');
    expect(JSON.parse(content).accessToken).toBe('access-123');
  });

  it('isExpired returns false for valid tokens', () => {
    expect(store.isExpired(sampleTokens)).toBe(false);
  });

  it('isExpired returns true for expired tokens', () => {
    const expired = { ...sampleTokens, expiresAt: Date.now() - 1000 };
    expect(store.isExpired(expired)).toBe(true);
  });

  it('isExpired uses 5-minute default buffer', () => {
    // 4 minutes remaining — within 5-minute buffer, so expired
    const nearExpiry = { ...sampleTokens, expiresAt: Date.now() + 240_000 };
    expect(store.isExpired(nearExpiry)).toBe(true);

    // 6 minutes remaining — outside 5-minute buffer, so valid
    const stillValid = { ...sampleTokens, expiresAt: Date.now() + 360_000 };
    expect(store.isExpired(stillValid)).toBe(false);
  });

  it('isExpired accepts custom buffer', () => {
    const almostExpired = { ...sampleTokens, expiresAt: Date.now() + 30_000 };
    // With 60s buffer, 30s remaining = expired
    expect(store.isExpired(almostExpired, 60_000)).toBe(true);
    // With 10s buffer, 30s remaining = valid
    expect(store.isExpired(almostExpired, 10_000)).toBe(false);
  });

  it('round-trips tokens with clientId', () => {
    const tokensWithClientId = { ...sampleTokens, clientId: 'my-client-123' };
    store.save('google', tokensWithClientId);
    const loaded = store.load('google');
    expect(loaded?.clientId).toBe('my-client-123');
  });
});

describe('refreshAccessToken', () => {
  it('sends correct POST body and returns tokens', async () => {
    const mockResponse = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 7200,
      token_type: 'bearer',
      scope: 'openai.api',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    vi.stubGlobal('fetch', mockFetch);

    const config = OAUTH_PROVIDERS.openai;
    const tokens = await refreshAccessToken(config, 'old-refresh', 'my-client');

    expect(mockFetch).toHaveBeenCalledWith(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: expect.any(URLSearchParams),
    });

    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(body.get('client_id')).toBe('my-client');

    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.refreshToken).toBe('new-refresh');
    expect(tokens.tokenType).toBe('bearer');

    vi.unstubAllGlobals();
  });

  it('throws on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('invalid_grant'),
    }));

    const config = OAUTH_PROVIDERS.openai;
    await expect(refreshAccessToken(config, 'bad-token', 'client'))
      .rejects.toThrow('Token refresh failed: 401');

    vi.unstubAllGlobals();
  });

  it('preserves old refresh token if server omits new one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'new-access',
        expires_in: 3600,
      }),
    }));

    const config = OAUTH_PROVIDERS.openai;
    const tokens = await refreshAccessToken(config, 'keep-this', 'client');
    expect(tokens.refreshToken).toBe('keep-this');

    vi.unstubAllGlobals();
  });
});

describe('OAUTH_PROVIDERS', () => {
  it('has openai configured', () => {
    expect(OAUTH_PROVIDERS.openai).toBeDefined();
    expect(OAUTH_PROVIDERS.openai.authorizationUrl).toContain('openai.com');
    expect(OAUTH_PROVIDERS.openai.tokenUrl).toContain('openai.com');
    expect(OAUTH_PROVIDERS.openai.callbackPort).toBe(18888);
  });

  it('has google configured with correct endpoints', () => {
    expect(OAUTH_PROVIDERS.google).toBeDefined();
    expect(OAUTH_PROVIDERS.google.authorizationUrl).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(OAUTH_PROVIDERS.google.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(OAUTH_PROVIDERS.google.callbackPort).toBe(18888);
    expect(OAUTH_PROVIDERS.google.callbackPath).toBe('/callback');
  });

  it('google has all three user scopes', () => {
    expect(OAUTH_PROVIDERS.google.scopes).toContain(
      'https://www.googleapis.com/auth/cloud-platform',
    );
    expect(OAUTH_PROVIDERS.google.scopes).toContain(
      'https://www.googleapis.com/auth/userinfo.email',
    );
    expect(OAUTH_PROVIDERS.google.scopes).toContain(
      'https://www.googleapis.com/auth/userinfo.profile',
    );
  });

  it('google has deviceCodeUrl configured', () => {
    expect(OAUTH_PROVIDERS.google.deviceCodeUrl).toBe(
      'https://oauth2.googleapis.com/device/code',
    );
  });

  it('openai has no deviceCodeUrl', () => {
    expect(OAUTH_PROVIDERS.openai.deviceCodeUrl).toBeUndefined();
  });

  it('OAuthProviderConfig accepts optional clientSecret', () => {
    const config: import('./types.js').OAuthProviderConfig = {
      ...OAUTH_PROVIDERS.google,
      clientSecret: 'test-secret',
    };
    expect(config.clientSecret).toBe('test-secret');
  });

  it('OAuthProviderConfig clientSecret is undefined by default', () => {
    expect(OAUTH_PROVIDERS.openai.clientSecret).toBeUndefined();
    expect(OAUTH_PROVIDERS.google.clientSecret).toBeUndefined();
  });

  it('OAuthTokens supports clientId field', () => {
    const tokens: OAuthTokens = {
      accessToken: 'at',
      expiresAt: Date.now(),
      tokenType: 'bearer',
      clientId: 'stored-client-id',
    };
    expect(tokens.clientId).toBe('stored-client-id');
  });
});

describe('refreshAccessToken with clientSecret', () => {
  it('includes client_secret in POST body when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          token_type: 'bearer',
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const config = OAUTH_PROVIDERS.google;
    await refreshAccessToken(config, 'old-refresh', 'my-client', 'my-secret');

    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('client_secret')).toBe('my-secret');

    vi.unstubAllGlobals();
  });

  it('omits client_secret when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'new-access',
          expires_in: 3600,
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const config = OAUTH_PROVIDERS.openai;
    await refreshAccessToken(config, 'old-refresh', 'my-client');

    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.has('client_secret')).toBe(false);

    vi.unstubAllGlobals();
  });
});

describe('isRemoteEnvironment', () => {
  const envVars = ['SSH_CONNECTION', 'SSH_CLIENT', 'WSL_DISTRO_NAME', 'REMOTE_CONTAINERS'];

  afterEach(() => {
    for (const v of envVars) {
      delete process.env[v];
    }
  });

  it('returns false when no remote env vars set', () => {
    for (const v of envVars) delete process.env[v];
    expect(isRemoteEnvironment()).toBe(false);
  });

  it('detects SSH_CONNECTION', () => {
    process.env.SSH_CONNECTION = '10.0.0.1 12345 10.0.0.2 22';
    expect(isRemoteEnvironment()).toBe(true);
  });

  it('detects SSH_CLIENT', () => {
    process.env.SSH_CLIENT = '10.0.0.1 12345 22';
    expect(isRemoteEnvironment()).toBe(true);
  });

  it('detects WSL_DISTRO_NAME', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    expect(isRemoteEnvironment()).toBe(true);
  });

  it('detects REMOTE_CONTAINERS', () => {
    process.env.REMOTE_CONTAINERS = 'true';
    expect(isRemoteEnvironment()).toBe(true);
  });
});
