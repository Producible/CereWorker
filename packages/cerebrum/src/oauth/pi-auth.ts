/**
 * OAuth helpers for integrated providers.
 *
 * OpenAI Codex is implemented locally so the runtime does not depend on
 * @mariozechner/pi-ai being installed globally. Google OAuth still falls back
 * to pi-ai for now.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { generateCodeChallenge, generateCodeVerifier } from './pkce.js';
import type { OAuthTokens } from './types.js';

type PiCreds = {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  projectId?: string;
  [k: string]: unknown;
};

const OPENAI_CODEX_TOKEN_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_TOKEN_CLAIM = 'https://api.openai.com/profile';
const OPENAI_CODEX_PROVIDER = 'openai-codex';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OPENAI_CODEX_SCOPE = 'openid profile email offline_access';
const OPENAI_OAUTH_ORIGINATOR = 'pi';
const PI_AI_MODULE = '@mariozechner/pi-ai/oauth';
const GOOGLE_INSTALL_HINT = '@mariozechner/pi-ai is required for Google OAuth. Install it:\n  npm install -g @mariozechner/pi-ai';

function toTokens(creds: PiCreds): OAuthTokens {
  const claims = decodeJwtClaims(creds.access);
  const auth = asRecord(claims?.[OPENAI_CODEX_TOKEN_CLAIM]);
  const profile = asRecord(claims?.[OPENAI_PROFILE_TOKEN_CLAIM]);
  const tokenEmail = typeof profile?.email === 'string' ? profile.email : undefined;
  const tokenAccountId = typeof auth?.chatgpt_account_id === 'string'
    ? auth.chatgpt_account_id
    : undefined;

  return {
    accessToken: creds.access,
    refreshToken: creds.refresh,
    expiresAt: creds.expires,
    tokenType: 'bearer',
    email: creds.email ?? tokenEmail,
    accountId: creds.accountId ?? tokenAccountId,
    projectId: creds.projectId,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPiAuth(): Promise<any> {
  try {
    return await import(PI_AI_MODULE);
  } catch {
    throw new Error(GOOGLE_INSTALL_HINT);
  }
}

export interface PiAuthCallbacks {
  onAuth: (url: string, instructions?: string) => void;
  onPrompt?: (message: string) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function createOpenAICodexState(): string {
  return randomBytes(16).toString('hex');
}

function parseOpenAICodexAuthorizationInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }

  return { code: value };
}

function openAIOAuthSuccessHtml(message: string): string {
  return `<!doctype html><html><body><h1>Success</h1><p>${message}</p></body></html>`;
}

function openAIOAuthErrorHtml(message: string): string {
  return `<!doctype html><html><body><h1>OAuth Error</h1><p>${message}</p></body></html>`;
}

function getOpenAICodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtClaims(accessToken);
  const auth = asRecord(payload?.[OPENAI_CODEX_TOKEN_CLAIM]);
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

function normalizeOpenAICodexTokens(
  creds: Pick<PiCreds, 'access' | 'refresh' | 'expires'>,
  fallback?: OAuthTokens,
): OAuthTokens {
  const decoded = toTokens(creds);
  if (decoded.accountId) {
    return decoded;
  }

  if (fallback?.accountId) {
    return {
      ...decoded,
      accountId: fallback.accountId,
      email: decoded.email ?? fallback.email,
    };
  }

  throw new Error('Failed to extract accountId from token');
}

async function exchangeOpenAICodexAuthorizationCode(
  code: string,
  verifier: string,
): Promise<OAuthTokens> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Codex token exchange failed: ${response.status} ${text || response.statusText}`);
  }

  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('OpenAI Codex token exchange returned an incomplete payload');
  }

  return normalizeOpenAICodexTokens({
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  });
}

function createOpenAICodexAuthorizationUrl(): {
  state: string;
  verifier: string;
  url: string;
} {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = createOpenAICodexState();
  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', OPENAI_CODEX_REDIRECT_URI);
  url.searchParams.set('scope', OPENAI_CODEX_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', OPENAI_OAUTH_ORIGINATOR);
  return { state, verifier, url: url.toString() };
}

async function startOpenAICodexCallbackServer(state: string): Promise<{
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
}> {
  let settleWait: ((value: { code: string } | null) => void) | undefined;
  const waitForCode = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  return await new Promise((resolve) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '', 'http://localhost');
        if (url.pathname !== '/auth/callback') {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(openAIOAuthErrorHtml('Callback route not found.'));
          return;
        }

        if (url.searchParams.get('state') !== state) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(openAIOAuthErrorHtml('State mismatch.'));
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(openAIOAuthErrorHtml('Missing authorization code.'));
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(openAIOAuthSuccessHtml('OpenAI authentication completed. You can close this window.'));
        settleWait?.({ code });
      } catch {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(openAIOAuthErrorHtml('Internal error while processing OAuth callback.'));
      }
    });

    server.listen(1455, '127.0.0.1', () => {
      resolve({
        close: () => server.close(),
        cancelWait: () => settleWait?.(null),
        waitForCode: () => waitForCode,
      });
    }).on('error', () => {
      settleWait?.(null);
      resolve({
        close: () => {
          try {
            server.close();
          } catch {
            // ignore
          }
        },
        cancelWait: () => {},
        waitForCode: async () => null,
      });
    });
  });
}

type OpenAIOAuthTlsPreflightResult =
  | { ok: true }
  | { ok: false; kind: 'tls-cert' | 'network'; code?: string; message: string };

const TLS_CERT_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const TLS_CERT_ERROR_PATTERNS = [
  /unable to get local issuer certificate/i,
  /unable to verify the first certificate/i,
  /self[- ]signed certificate/i,
  /certificate has expired/i,
];

const OPENAI_AUTH_PROBE_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&client_id=cereworker-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email';

function extractTlsPreflightFailure(error: unknown): {
  code?: string;
  kind: 'tls-cert' | 'network';
  message: string;
} {
  const root = asRecord(error);
  const rootCause = asRecord(root?.cause);
  const code = typeof rootCause?.code === 'string' ? rootCause.code : undefined;
  const message =
    typeof rootCause?.message === 'string'
      ? rootCause.message
      : typeof root?.message === 'string'
        ? root.message
        : String(error);
  const kind = (
    (code ? TLS_CERT_ERROR_CODES.has(code) : false)
      || TLS_CERT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  ) ? 'tls-cert' : 'network';
  return { code, kind, message };
}

async function runOpenAIOAuthTlsPreflight(): Promise<OpenAIOAuthTlsPreflightResult> {
  try {
    await fetch(OPENAI_AUTH_PROBE_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    return { ok: true };
  } catch (error) {
    const failure = extractTlsPreflightFailure(error);
    return { ok: false, ...failure };
  }
}

function formatOpenAIOAuthTlsPreflightFix(
  result: Exclude<OpenAIOAuthTlsPreflightResult, { ok: true }>,
): string {
  if (result.kind !== 'tls-cert') {
    return [
      'OpenAI OAuth prerequisite check failed due to a network error before browser login.',
      `Cause: ${result.message}`,
      'Verify connectivity to auth.openai.com and try again.',
    ].join('\n');
  }

  return [
    'OpenAI OAuth prerequisite check failed: Node cannot validate TLS certificates.',
    `Cause: ${result.code ? `${result.code} (${result.message})` : result.message}`,
    'On macOS/Homebrew Node, re-run `brew postinstall ca-certificates` and `brew postinstall openssl@3`, then retry.',
  ].join('\n');
}

export async function loginOpenAICodex(callbacks: PiAuthCallbacks): Promise<OAuthTokens> {
  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === 'tls-cert') {
    throw new Error(formatOpenAIOAuthTlsPreflightFix(preflight));
  }

  const { verifier, state, url } = createOpenAICodexAuthorizationUrl();
  const server = await startOpenAICodexCallbackServer(state);
  callbacks.onAuth(url, 'A browser window should open. Complete login to finish.');

  let code: string | undefined;
  try {
    if (callbacks.onManualCodeInput) {
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = callbacks
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((error: unknown) => {
          manualError = error instanceof Error ? error : new Error(String(error));
          server.cancelWait();
        });

      const result = await server.waitForCode();
      if (manualError) {
        throw manualError;
      }

      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        const parsed = parseOpenAICodexAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) {
          throw new Error('State mismatch');
        }
        code = parsed.code;
      }

      if (!code) {
        await manualPromise;
        if (manualError) {
          throw manualError;
        }
        if (manualCode) {
          const parsed = parseOpenAICodexAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) {
            throw new Error('State mismatch');
          }
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
      }
    }

    if (!code) {
      if (!callbacks.onPrompt) {
        throw new Error('Missing authorization code');
      }
      const input = await callbacks.onPrompt('Paste the authorization code (or full redirect URL)');
      const parsed = parseOpenAICodexAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error('State mismatch');
      }
      code = parsed.code;
    }

    if (!code) {
      throw new Error('Missing authorization code');
    }

    return await exchangeOpenAICodexAuthorizationCode(code, verifier);
  } finally {
    server.close();
  }
}

export async function loginOpenAI(callbacks: PiAuthCallbacks): Promise<OAuthTokens> {
  return loginOpenAICodex(callbacks);
}

export async function loginGoogle(callbacks: PiAuthCallbacks): Promise<OAuthTokens> {
  const { loginGeminiCli } = await loadPiAuth();
  const creds = await loginGeminiCli(
    (info: { url: string; instructions?: string }) => callbacks.onAuth(info.url, info.instructions),
    callbacks.onProgress,
    callbacks.onManualCodeInput,
  );
  return toTokens(creds);
}

export async function refreshOpenAICodexToken(refreshToken: string, fallback?: OAuthTokens): Promise<OAuthTokens> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Codex token refresh failed: ${response.status} ${text || response.statusText}`);
  }

  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new Error('OpenAI Codex token refresh returned an incomplete payload');
  }

  return normalizeOpenAICodexTokens(
    {
      access: json.access_token,
      refresh: json.refresh_token || refreshToken,
      expires: Date.now() + json.expires_in * 1000,
    },
    fallback,
  );
}

export async function refreshOpenAIToken(refreshToken: string): Promise<OAuthTokens> {
  return refreshOpenAICodexToken(refreshToken);
}

export async function getOpenAICodexApiKey(tokens: OAuthTokens): Promise<{
  apiKey: string;
  tokens: OAuthTokens;
}> {
  let nextTokens = tokens;
  if (Date.now() >= tokens.expiresAt) {
    if (!tokens.refreshToken) {
      throw new Error('OpenAI Codex OAuth token expired and no refresh token is available');
    }
    nextTokens = await refreshOpenAICodexToken(tokens.refreshToken, tokens);
  }

  if (!nextTokens.accountId) {
    throw new Error('No OAuth credentials available for openai-codex');
  }

  return {
    apiKey: nextTokens.accessToken,
    tokens: nextTokens,
  };
}

export async function refreshGoogleToken(
  refreshToken: string,
  projectId: string,
): Promise<OAuthTokens> {
  const { refreshGoogleCloudToken } = await loadPiAuth();
  return toTokens(await refreshGoogleCloudToken(refreshToken, projectId));
}
