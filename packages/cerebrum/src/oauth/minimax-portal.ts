import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OAuthTokens } from './types.js';
import type { PiAuthCallbacks } from './pi-auth.js';

type MiniMaxRegion = 'cn' | 'global';

type MiniMaxOAuthAuthorization = {
  user_code: string;
  verification_uri: string;
  expired_in: number;
  interval?: number;
  state: string;
};

type MiniMaxOAuthToken = {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
  notificationMessage?: string;
};

type MiniMaxOAuthEndpoints = {
  oauthBaseUrl: string;
  runtimeBaseUrl: string;
  clientId: string;
  codeEndpoint: string;
  tokenEndpoint: string;
};

const MINIMAX_OAUTH_CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113';
const MINIMAX_OAUTH_SCOPE = 'group_id profile model.completion';
const MINIMAX_OAUTH_USER_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:user_code';
const MINIMAX_GLOBAL_OAUTH_BASE_URL = 'https://api.minimax.io';
const MINIMAX_CN_OAUTH_BASE_URL = 'https://api.minimaxi.com';
const MINIMAX_GLOBAL_RUNTIME_BASE_URL = 'https://api.minimax.io/anthropic';
const MINIMAX_CN_RUNTIME_BASE_URL = 'https://api.minimaxi.com/anthropic';

function resolveMiniMaxRegion(baseUrl?: string): MiniMaxRegion {
  if (baseUrl?.toLowerCase().includes('minimaxi.com')) {
    return 'cn';
  }
  return 'global';
}

function resolveMiniMaxOAuthEndpoints(baseUrl?: string): MiniMaxOAuthEndpoints {
  const region = resolveMiniMaxRegion(baseUrl);
  const oauthBaseUrl = region === 'cn' ? MINIMAX_CN_OAUTH_BASE_URL : MINIMAX_GLOBAL_OAUTH_BASE_URL;
  const runtimeBaseUrl = region === 'cn' ? MINIMAX_CN_RUNTIME_BASE_URL : MINIMAX_GLOBAL_RUNTIME_BASE_URL;
  return {
    oauthBaseUrl,
    runtimeBaseUrl,
    clientId: MINIMAX_OAUTH_CLIENT_ID,
    codeEndpoint: `${oauthBaseUrl}/oauth/code`,
    tokenEndpoint: `${oauthBaseUrl}/oauth/token`,
  };
}

function toFormBody(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

function createPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function createMiniMaxState(): string {
  return randomBytes(16).toString('base64url');
}

function toTokens(token: MiniMaxOAuthToken, baseUrl?: string): OAuthTokens {
  const endpoints = resolveMiniMaxOAuthEndpoints(baseUrl);
  const resolvedBaseUrl = token.resourceUrl || baseUrl || endpoints.runtimeBaseUrl;
  return {
    accessToken: token.access,
    refreshToken: token.refresh,
    expiresAt: token.expires,
    tokenType: 'bearer',
    baseUrl: resolvedBaseUrl,
    resourceUrl: token.resourceUrl,
  };
}

function parseMiniMaxTokenPayload(
  payload: Record<string, unknown>,
  params: {
    refreshTokenFallback?: string;
  } = {},
): MiniMaxOAuthToken {
  const access = typeof payload.access_token === 'string' ? payload.access_token : undefined;
  const refresh = typeof payload.refresh_token === 'string'
    ? payload.refresh_token
    : params.refreshTokenFallback;
  const expires = typeof payload.expired_in === 'number'
    ? payload.expired_in
    : typeof payload.expires_in === 'number'
      ? Date.now() + payload.expires_in * 1000
      : undefined;
  const resourceUrl = typeof payload.resource_url === 'string' ? payload.resource_url : undefined;
  const notificationMessage = typeof payload.notification_message === 'string'
    ? payload.notification_message
    : undefined;

  if (!access || !refresh || !expires) {
    throw new Error('MiniMax OAuth returned an incomplete token payload.');
  }

  return {
    access,
    refresh,
    expires,
    resourceUrl,
    notificationMessage,
  };
}

async function requestMiniMaxOAuthCode(baseUrl?: string): Promise<{
  authorization: MiniMaxOAuthAuthorization;
  verifier: string;
}> {
  const endpoints = resolveMiniMaxOAuthEndpoints(baseUrl);
  const verifier = createPkceVerifier();
  const challenge = createPkceChallenge(verifier);
  const state = createMiniMaxState();

  const response = await fetch(endpoints.codeEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'x-request-id': randomUUID(),
    },
    body: toFormBody({
      response_type: 'code',
      client_id: endpoints.clientId,
      scope: MINIMAX_OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MiniMax OAuth authorization failed: ${text || response.statusText}`);
  }

  const payload = await response.json() as MiniMaxOAuthAuthorization & { error?: string };
  if (!payload.user_code || !payload.verification_uri) {
    throw new Error(
      payload.error
        ?? 'MiniMax OAuth authorization returned an incomplete payload (missing user_code or verification_uri).',
    );
  }
  if (payload.state !== state) {
    throw new Error('MiniMax OAuth state mismatch: possible CSRF or session corruption.');
  }

  return { authorization: payload, verifier };
}

async function postMiniMaxTokenRequest(
  body: Record<string, string>,
  baseUrl?: string,
  refreshTokenFallback?: string,
  mode: 'poll' | 'refresh' = 'poll',
): Promise<Record<string, unknown>> {
  const endpoints = resolveMiniMaxOAuthEndpoints(baseUrl);
  const response = await fetch(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: toFormBody(body),
  });

  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const baseResp = payload?.base_resp as Record<string, unknown> | undefined;
    const message = typeof baseResp?.status_msg === 'string'
      ? baseResp.status_msg
      : text || response.statusText;
    throw new Error(`MiniMax OAuth failed: ${message}`);
  }

  if (!payload) {
    throw new Error('MiniMax OAuth failed to parse response.');
  }

  const status = typeof payload.status === 'string' ? payload.status : undefined;
  if (status === 'error') {
    throw new Error('MiniMax OAuth returned an error.');
  }

  if (status && status !== 'success' && !('access_token' in payload)) {
    if (mode === 'poll') {
      throw new Error('MiniMax OAuth is still pending authorization.');
    }
    throw new Error(typeof payload.status === 'string' ? payload.status : 'MiniMax OAuth refresh did not return an access token.');
  }

  const parsed = parseMiniMaxTokenPayload(payload, { refreshTokenFallback });
  return {
    access_token: parsed.access,
    refresh_token: parsed.refresh,
    expired_in: parsed.expires,
    ...(parsed.resourceUrl ? { resource_url: parsed.resourceUrl } : {}),
    ...(parsed.notificationMessage ? { notification_message: parsed.notificationMessage } : {}),
  };
}

async function pollMiniMaxOAuthToken(params: {
  userCode: string;
  verifier: string;
  baseUrl?: string;
  expiresAt: number;
  intervalMs: number;
  callbacks?: Pick<PiAuthCallbacks, 'onProgress'>;
}): Promise<MiniMaxOAuthToken> {
  const endpoints = resolveMiniMaxOAuthEndpoints(params.baseUrl);
  while (Date.now() < params.expiresAt) {
    params.callbacks?.onProgress?.('Waiting for MiniMax OAuth approval...');

    try {
      const payload = await postMiniMaxTokenRequest({
        grant_type: MINIMAX_OAUTH_USER_CODE_GRANT,
        client_id: endpoints.clientId,
        user_code: params.userCode,
        code_verifier: params.verifier,
      }, params.baseUrl, undefined, 'poll');
      return parseMiniMaxTokenPayload(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('pending authorization')) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(params.intervalMs, 2000)));
  }

  throw new Error('MiniMax OAuth timed out before authorization completed.');
}

export async function loginMiniMaxPortal(
  callbacks: PiAuthCallbacks & { baseUrl?: string },
): Promise<OAuthTokens> {
  const { authorization, verifier } = await requestMiniMaxOAuthCode(callbacks.baseUrl);
  callbacks.onAuth(
    authorization.verification_uri,
    `If prompted, enter the code ${authorization.user_code}.`,
  );

  const token = await pollMiniMaxOAuthToken({
    userCode: authorization.user_code,
    verifier,
    baseUrl: callbacks.baseUrl,
    expiresAt: authorization.expired_in,
    intervalMs: authorization.interval ?? 2000,
    callbacks,
  });
  return toTokens(token, callbacks.baseUrl);
}

export async function refreshMiniMaxPortalToken(
  refreshToken: string,
  baseUrl?: string,
): Promise<OAuthTokens> {
  const endpoints = resolveMiniMaxOAuthEndpoints(baseUrl);
  const payload = await postMiniMaxTokenRequest({
    grant_type: 'refresh_token',
    client_id: endpoints.clientId,
    refresh_token: refreshToken,
  }, baseUrl, refreshToken, 'refresh');

  return toTokens(parseMiniMaxTokenPayload(payload, { refreshTokenFallback: refreshToken }), baseUrl);
}
