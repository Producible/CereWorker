import { randomBytes, createHash } from 'node:crypto';
import type { OAuthProviderConfig } from './types.js';

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizationUrl(
  config: OAuthProviderConfig,
  codeChallenge: string,
  state: string,
  clientIdOverride?: string,
  extraParams?: Record<string, string>,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientIdOverride ?? config.clientId,
    redirect_uri: `http://localhost:${config.callbackPort}${config.callbackPath}`,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: config.scopes.join(' '),
    state,
    ...extraParams,
  });
  return `${config.authorizationUrl}?${params}`;
}
