import { exec } from 'node:child_process';
import { createInterface } from 'node:readline';
import { platform } from 'node:os';
import { loadConfig } from '@cereworker/config';
import {
  runOAuthFlow,
  TokenStore,
  OAUTH_PROVIDERS,
  isRemoteEnvironment,
  loginOpenAI,
  loginGoogle,
} from '@cereworker/cerebrum';

function openBrowser(url: string): void {
  const cmd =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`);
}

function promptLine(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const PI_AI_PROVIDERS = new Set(['openai', 'google']);

export async function runAuth(provider: string): Promise<void> {
  if (!OAUTH_PROVIDERS[provider] && !PI_AI_PROVIDERS.has(provider)) {
    console.error(`OAuth not supported for provider: ${provider}`);
    console.error(`Supported: ${[...new Set([...Object.keys(OAUTH_PROVIDERS), ...PI_AI_PROVIDERS])].join(', ')}`);
    process.exit(1);
  }

  const remote = isRemoteEnvironment();

  console.log(`\nAuthenticating with ${provider} via OAuth...`);
  if (remote) {
    console.log('Remote environment detected. You may need to paste a URL.\n');
  } else {
    console.log('A browser window will open. Sign in and authorize CereWorker.\n');
  }

  const store = new TokenStore();

  // Use pi-ai for OpenAI and Google (handles Client IDs internally)
  if (PI_AI_PROVIDERS.has(provider)) {
    const loginFn = provider === 'openai' ? loginOpenAI : loginGoogle;
    const tokens = await loginFn({
      onAuth: (url) => {
        if (remote) {
          console.log(`Open this URL in your browser:\n  ${url}\n`);
        } else {
          console.log('Opening browser...');
          openBrowser(url);
          console.log(`\nIf the browser didn't open, visit:\n  ${url}\n`);
        }
      },
      onPrompt: (message) => promptLine(`${message}: `),
      onProgress: (msg) => console.log(msg),
      onManualCodeInput: remote
        ? () => promptLine('\nPaste the redirect URL from your browser: ')
        : undefined,
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
