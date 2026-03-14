import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import type { OAuthProviderConfig, OAuthTokens } from './types.js';

const DEFAULT_OAUTH_DIR = join(homedir(), '.cereworker', 'oauth');

export class TokenStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_OAUTH_DIR;
  }

  save(provider: string, tokens: OAuthTokens): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      join(this.dir, `${provider}.json`),
      JSON.stringify(tokens, null, 2),
      { mode: 0o600 },
    );
  }

  load(provider: string): OAuthTokens | null {
    const path = join(this.dir, `${provider}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  delete(provider: string): void {
    const path = join(this.dir, `${provider}.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  isExpired(tokens: OAuthTokens, bufferMs = 300_000): boolean {
    return Date.now() >= tokens.expiresAt - bufferMs;
  }
}

export async function refreshAccessToken(
  providerConfig: OAuthProviderConfig,
  refreshToken: string,
  clientId?: string,
  clientSecret?: string,
): Promise<OAuthTokens> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId ?? providerConfig.clientId,
  };
  const secret = clientSecret ?? providerConfig.clientSecret;
  if (secret) params.client_secret = secret;

  const res = await fetch(providerConfig.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
    expiresAt: Date.now() + ((data.expires_in as number | undefined) ?? 3600) * 1000,
    tokenType: (data.token_type as string | undefined) ?? 'bearer',
    scope: data.scope as string | undefined,
  };
}
