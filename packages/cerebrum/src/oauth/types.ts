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
  projectId?: string; // Google Cloud project ID
}

/**
 * Provider-specific OAuth endpoints.
 * Users override clientId in their config (register their own OAuth app).
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  openai: {
    authorizationUrl: 'https://auth0.openai.com/authorize',
    tokenUrl: 'https://auth0.openai.com/oauth/token',
    clientId: '', // Must be provided by user in config
    scopes: ['openai.organization.read', 'openai.api'],
    callbackPort: 18888,
    callbackPath: '/callback',
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
