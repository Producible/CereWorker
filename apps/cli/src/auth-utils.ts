const OPENAI_CODEX_PROVIDER = 'openai-codex';
const INTEGRATED_OAUTH_PROVIDERS = new Set([OPENAI_CODEX_PROVIDER, 'google', 'minimax-portal']);

export function canonicalizeOAuthProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'openai' ? OPENAI_CODEX_PROVIDER : normalized;
}

export function isIntegratedOAuthProvider(provider: string): boolean {
  return INTEGRATED_OAUTH_PROVIDERS.has(provider);
}

export function listSupportedOAuthProviders(genericProviders: string[]): string[] {
  return [...new Set(['openai', ...genericProviders, ...INTEGRATED_OAUTH_PROVIDERS])];
}
