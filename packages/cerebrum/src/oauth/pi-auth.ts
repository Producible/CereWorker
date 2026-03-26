/**
 * OAuth login wrappers for OpenAI and Google.
 *
 * OpenAI: Uses CereWorker's own PKCE flow with the correct scopes
 * (including api.responses.write for GPT-5.4 Responses API).
 *
 * Google: Falls back to @mariozechner/pi-ai for Gemini CLI OAuth.
 */
import { OAUTH_PROVIDERS, type OAuthTokens } from './types.js';
import { runOAuthFlow } from './flow.js';

type PiCreds = { access: string; refresh: string; expires: number; [k: string]: unknown };

function toTokens(creds: PiCreds): OAuthTokens {
  return {
    accessToken: creds.access,
    refreshToken: creds.refresh,
    expiresAt: creds.expires,
    tokenType: 'bearer',
    email: creds.email as string | undefined,
    projectId: creds.projectId as string | undefined,
  };
}

const PI_AI_MODULE = '@mariozechner/pi-ai/oauth';
const INSTALL_HINT = 'Google OAuth requires @mariozechner/pi-ai. Install it:\n  npm install -g @mariozechner/pi-ai';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPiAuth(): Promise<any> {
  try {
    return await import(PI_AI_MODULE);
  } catch {
    throw new Error(INSTALL_HINT);
  }
}

export interface PiAuthCallbacks {
  onAuth: (url: string, instructions?: string) => void;
  onPrompt?: (message: string) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
}

export async function loginOpenAI(callbacks: PiAuthCallbacks): Promise<OAuthTokens> {
  // Use CereWorker's own PKCE flow with correct scopes (api.responses.write)
  return runOAuthFlow('openai', {
    onReady: (url) => callbacks.onAuth(url),
  });
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

export async function refreshOpenAIToken(refreshToken: string): Promise<OAuthTokens> {
  const config = OAUTH_PROVIDERS.openai;
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) ?? refreshToken,
    expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    tokenType: (data.token_type as string) ?? 'bearer',
  };
}

export async function refreshGoogleToken(
  refreshToken: string,
  projectId: string,
): Promise<OAuthTokens> {
  const { refreshGoogleCloudToken } = await loadPiAuth();
  return toTokens(await refreshGoogleCloudToken(refreshToken, projectId));
}
