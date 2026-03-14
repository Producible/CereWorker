/**
 * Thin wrappers around @mariozechner/pi-ai OAuth login & refresh functions.
 * Converts pi-ai credential format to CereWorker OAuthTokens.
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

export interface PiAuthCallbacks {
  onAuth: (url: string, instructions?: string) => void;
  onPrompt?: (message: string) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
}

export async function loginOpenAI(callbacks: PiAuthCallbacks): Promise<OAuthTokens> {
  const { loginOpenAICodex } = await import('@mariozechner/pi-ai/oauth');
  const creds = await loginOpenAICodex({
    onAuth: (info) => callbacks.onAuth(info.url, info.instructions),
    onPrompt: async (prompt) => {
      if (!callbacks.onPrompt) throw new Error('Manual input required but no prompt handler');
      return callbacks.onPrompt(prompt.message);
    },
    onProgress: callbacks.onProgress,
    onManualCodeInput: callbacks.onManualCodeInput,
  });
  return toTokens(creds);
}

export async function loginGoogle(callbacks: PiAuthCallbacks): Promise<OAuthTokens> {
  const { loginGeminiCli } = await import('@mariozechner/pi-ai/oauth');
  const creds = await loginGeminiCli(
    (info) => callbacks.onAuth(info.url, info.instructions),
    callbacks.onProgress,
    callbacks.onManualCodeInput,
  );
  return toTokens(creds);
}

export async function refreshOpenAIToken(refreshToken: string): Promise<OAuthTokens> {
  const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai/oauth');
  return toTokens(await refreshOpenAICodexToken(refreshToken));
}

export async function refreshGoogleToken(
  refreshToken: string,
  projectId: string,
): Promise<OAuthTokens> {
  const { refreshGoogleCloudToken } = await import('@mariozechner/pi-ai/oauth');
  return toTokens(await refreshGoogleCloudToken(refreshToken, projectId));
}
