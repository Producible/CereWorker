import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { OAUTH_PROVIDERS, type OAuthProviderConfig, type OAuthTokens } from './types.js';
import { generateCodeVerifier, generateCodeChallenge, buildAuthorizationUrl } from './pkce.js';

export interface OAuthFlowOptions {
  clientId?: string;
  clientSecret?: string;
  onReady?: (authUrl: string) => void;
}

export function isRemoteEnvironment(): boolean {
  return !!(
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.WSL_DISTRO_NAME ||
    process.env.REMOTE_CONTAINERS
  );
}

/**
 * Run the full OAuth Authorization Code + PKCE flow.
 *
 * In remote/WSL environments, falls back to manual paste of the redirect URL.
 * Uses the PKCE code verifier as the OAuth state parameter.
 */
export async function runOAuthFlow(
  provider: string,
  options?: OAuthFlowOptions,
): Promise<OAuthTokens> {
  const config = OAUTH_PROVIDERS[provider];
  if (!config) throw new Error(`No OAuth config for provider: ${provider}`);

  const clientId = options?.clientId ?? config.clientId;
  if (!clientId) {
    throw new Error(
      `OAuth clientId required for ${provider}. Set cerebrum.providers.${provider}.oauth.clientId in config.`,
    );
  }

  const clientSecret = options?.clientSecret ?? config.clientSecret;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Use verifier as state (same pattern as OpenClaw)
  // OpenAI requires 'originator' param, 'audience' for token requests
  const extraParams = provider === 'openai' ? { originator: 'cereworker' } : undefined;
  const authUrl = buildAuthorizationUrl(config, codeChallenge, codeVerifier, clientId, extraParams);

  let code: string;
  if (isRemoteEnvironment()) {
    options?.onReady?.(authUrl);
    code = await manualCodeEntry(codeVerifier);
  } else {
    code = await startCallbackServer(config, codeVerifier, () => {
      options?.onReady?.(authUrl);
    });
  }

  const tokens = await exchangeCode(config, code, codeVerifier, clientId, clientSecret);
  tokens.clientId = clientId;
  return tokens;
}

export interface DeviceCodeFlowOptions {
  clientId?: string;
  clientSecret?: string;
  onUserCode?: (userCode: string, verificationUri: string) => void;
}

/**
 * Run the OAuth Device Authorization Grant flow.
 * Used for headless environments where browser-based redirect isn't possible.
 * Provider must have `deviceCodeUrl` configured.
 */
export async function runDeviceCodeFlow(
  provider: string,
  options?: DeviceCodeFlowOptions,
): Promise<OAuthTokens> {
  const config = OAUTH_PROVIDERS[provider];
  if (!config) throw new Error(`No OAuth config for provider: ${provider}`);
  if (!config.deviceCodeUrl) {
    throw new Error(`Provider ${provider} does not support device code flow`);
  }

  const clientId = options?.clientId ?? config.clientId;
  if (!clientId) {
    throw new Error(
      `OAuth clientId required for ${provider}. Set cerebrum.providers.${provider}.oauth.clientId in config.`,
    );
  }

  const clientSecret = options?.clientSecret ?? config.clientSecret;

  // Step 1: Request device code
  const deviceRes = await fetch(config.deviceCodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope: config.scopes.join(' '),
    }),
  });

  if (!deviceRes.ok) {
    const body = await deviceRes.text();
    throw new Error(`Device code request failed: ${deviceRes.status} ${body}`);
  }

  const deviceData = (await deviceRes.json()) as Record<string, unknown>;
  const deviceCode = deviceData.device_code as string;
  const userCode = deviceData.user_code as string;
  const verificationUri = deviceData.verification_uri as string;
  const expiresIn = (deviceData.expires_in as number) ?? 300;
  let interval = ((deviceData.interval as number) ?? 5) * 1000;

  options?.onUserCode?.(userCode, verificationUri);

  // Step 2: Poll for token
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const params: Record<string, string> = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    };
    if (clientSecret) params.client_secret = clientSecret;

    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });

    const tokenData = (await tokenRes.json()) as Record<string, unknown>;

    if (tokenRes.ok) {
      return {
        accessToken: tokenData.access_token as string,
        refreshToken: tokenData.refresh_token as string | undefined,
        expiresAt: Date.now() + ((tokenData.expires_in as number) ?? 3600) * 1000,
        tokenType: (tokenData.token_type as string) ?? 'bearer',
        scope: tokenData.scope as string | undefined,
        clientId,
      };
    }

    const error = tokenData.error as string;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }

    throw new Error(`Device code flow failed: ${error}`);
  }

  throw new Error('Device code flow timed out');
}

function manualCodeEntry(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });

    rl.question(
      '\nPaste the redirect URL from your browser: ',
      (input) => {
        rl.close();
        try {
          const url = new URL(input.trim());
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            reject(new Error(`OAuth error: ${error}`));
            return;
          }
          if (state !== expectedState) {
            reject(new Error('OAuth state mismatch — possible CSRF attack'));
            return;
          }
          if (!code) {
            reject(new Error('No authorization code in URL'));
            return;
          }
          resolve(code);
        } catch {
          reject(new Error(`Invalid URL: ${input}`));
        }
      },
    );
  });
}

function startCallbackServer(
  config: OAuthProviderConfig,
  expectedState: string,
  onListening: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${config.callbackPort}`);
      if (url.pathname !== config.callbackPath) {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization failed</h2><p>You can close this tab.</p>');
        server.close();
        settle(() => reject(new Error(`OAuth error: ${error}`)));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>Invalid state</h2>');
        server.close();
        settle(() => reject(new Error('OAuth state mismatch')));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorized!</h2><p>You can close this tab and return to CereWorker.</p>');
      server.close();
      settle(() => resolve(code!));
    });

    server.listen(config.callbackPort, () => {
      onListening();
    });

    const timeout = setTimeout(() => {
      server.close();
      settle(() => reject(new Error('OAuth callback timed out (5 minutes)')));
    }, 300_000);

    server.on('close', () => clearTimeout(timeout));
  });
}

async function exchangeCode(
  config: OAuthProviderConfig,
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret?: string,
): Promise<OAuthTokens> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: `http://localhost:${config.callbackPort}${config.callbackPath}`,
    client_id: clientId,
    code_verifier: codeVerifier,
  };
  if (clientSecret) params.client_secret = clientSecret;

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string | undefined,
    expiresAt: Date.now() + ((data.expires_in as number | undefined) ?? 3600) * 1000,
    tokenType: (data.token_type as string | undefined) ?? 'bearer',
    scope: data.scope as string | undefined,
  };
}
