import { createInterface } from 'node:readline';
import { loadConfig } from '@cereworker/config';
import {
  loginMiniMaxPortal,
  runOAuthFlow,
  TokenStore,
  OAUTH_PROVIDERS,
  isRemoteEnvironment,
  loginOpenAICodex,
  loginGoogle,
} from '@cereworker/cerebrum';
import { canonicalizeOAuthProvider, isIntegratedOAuthProvider, listSupportedOAuthProviders } from './auth-utils.js';
import { openBrowser } from './open-browser.js';

function promptLine(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runAuth(inputProvider: string): Promise<void> {
  const provider = canonicalizeOAuthProvider(inputProvider);

  if (!OAUTH_PROVIDERS[provider] && !isIntegratedOAuthProvider(provider)) {
    console.error(`OAuth not supported for provider: ${inputProvider}`);
    console.error(`Supported: ${listSupportedOAuthProviders(Object.keys(OAUTH_PROVIDERS)).join(', ')}`);
    process.exit(1);
  }

  const remote = isRemoteEnvironment();

  if (inputProvider.trim().toLowerCase() === 'openai' && provider !== inputProvider.trim().toLowerCase()) {
    console.log(`\n'openai' OAuth is now exposed as '${provider}'. Continuing with ${provider}...`);
  }

  console.log(`\nAuthenticating with ${provider} via OAuth...`);
  if (remote) {
    console.log('Remote environment detected. You may need to paste a URL.\n');
  } else {
    console.log('A browser window will open. Sign in and authorize CereWorker.\n');
  }

  const store = new TokenStore();

  // Use provider-owned OAuth flows where supported.
  if (isIntegratedOAuthProvider(provider)) {
    const config = loadConfig();
    const providerConfig =
      config.cerebrum.providers[provider as keyof typeof config.cerebrum.providers];
    const commonCallbacks = {
      onAuth: (url: string) => {
        if (remote) {
          console.log(`Open this URL in your browser:\n  ${url}\n`);
        } else {
          console.log('Opening browser...');
          openBrowser(url);
          console.log(`\nIf the browser didn't open, visit:\n  ${url}\n`);
        }
      },
      onPrompt: (message: string) => promptLine(`${message}: `),
      onProgress: (msg: string) => console.log(msg),
      onManualCodeInput: remote
        ? () => promptLine('\nPaste the redirect URL from your browser: ')
        : undefined,
    };
    const tokens = provider === 'openai-codex'
      ? await loginOpenAICodex(commonCallbacks)
      : provider === 'google'
        ? await loginGoogle(commonCallbacks)
        : await loginMiniMaxPortal({
            ...commonCallbacks,
            baseUrl: providerConfig?.baseUrl,
          });

    store.save(provider, tokens);
  } else {
    // Generic PKCE flow for other providers
    const config = loadConfig();
    const providerConfig =
      config.cerebrum.providers[provider as keyof typeof config.cerebrum.providers];
    const clientId = providerConfig?.oauth?.clientId;
    const clientSecret = providerConfig?.oauth?.clientSecret;

    if (!clientId && !OAUTH_PROVIDERS[provider].clientId) {
      console.error(
        `OAuth clientId required. Set cerebrum.providers.${provider}.oauth.clientId in config.`,
      );
      process.exit(1);
    }

    const tokens = await runOAuthFlow(provider, {
      clientId: clientId ?? undefined,
      clientSecret,
      onReady: (authUrl) => {
        if (remote) {
          console.log(`Open this URL in your browser:\n  ${authUrl}\n`);
          console.log('After authorizing, copy the URL your browser redirected to.');
        } else {
          console.log('Opening browser...');
          openBrowser(authUrl);
          console.log(`\nIf the browser didn't open, visit:\n  ${authUrl}\n`);
          console.log('Waiting for authorization...');
        }
      },
    });

    store.save(provider, tokens);
  }

  console.log(`\nAuthenticated! Token saved to ~/.cereworker/oauth/${provider}.json`);
}
