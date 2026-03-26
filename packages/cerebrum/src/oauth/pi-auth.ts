/**
 * OAuth login wrappers for OpenAI and Google.
 *
 * OpenAI: Uses CereWorker's own PKCE flow with the correct scopes
 * (including api.responses.write for GPT-5.4 Responses API).
 *
 * Google: Falls back to @mariozechner/pi-ai for Gemini CLI OAuth.
 */
import type { OAuthTokens } from './types.js';

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
  const { loginOpenAICodex } = await loadPiAuth();
  const creds = await loginOpenAICodex({
    onAuth: (info: { url: string; instructions?: string }) => callbacks.onAuth(info.url, info.instructions),
    onPrompt: async (prompt: { message: string }) => {
      if (!callbacks.onPrompt) throw new Error('Manual input required but no prompt handler');
      return callbacks.onPrompt(prompt.message);
    },
    onProgress: callbacks.onProgress,
    onManualCodeInput: callbacks.onManualCodeInput,
  });
  return toTokens(creds);
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
  const { refreshOpenAICodexToken } = await loadPiAuth();
  return toTokens(await refreshOpenAICodexToken(refreshToken));
}

export async function refreshGoogleToken(
  refreshToken: string,
  projectId: string,
): Promise<OAuthTokens> {
  const { refreshGoogleCloudToken } = await loadPiAuth();
  return toTokens(await refreshGoogleCloudToken(refreshToken, projectId));
}
