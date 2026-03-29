export interface OAuthProviderConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  deviceCodeUrl?: string;
  scopes: string[];
  callbackPort: number;
  callbackPath: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  tokenType: string;
  scope?: string;
  clientId?: string;
  email?: string;
  accountId?: string;
  projectId?: string; // Google Cloud project ID
  baseUrl?: string;
  resourceUrl?: string;
}

/**
 * Provider-specific OAuth endpoints.
 * Users override clientId in their config (register their own OAuth app).
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  openai: {
    authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EGHCdX7rkVuFnqAqtCp6L',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    callbackPort: 1455,
    callbackPath: '/auth/callback',
  },
  google: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: '',
    deviceCodeUrl: 'https://oauth2.googleapis.com/device/code',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    callbackPort: 18888,
    callbackPath: '/callback',
  },
};
