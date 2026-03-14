import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { clack, guardCancel } from '../prompter.js';
import { loginOpenAI, loginGoogle, TokenStore } from '@cereworker/cerebrum';

export interface CerebrumResult {
  provider: string;
  model: string;
  apiKey?: { envRef: string } | { plaintext: string };
  localBaseUrl?: string;
  auth?: 'apikey' | 'oauth';
  oauthClientId?: string;
  oauthClientSecret?: string;
}

const PROVIDER_MODELS: Record<string, { value: string; label: string; hint?: string }[]> = {
  anthropic: [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'default, great balance' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', hint: 'most capable' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', hint: 'fastest, cheapest' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o', hint: 'default' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini', hint: 'faster, cheaper' },
    { value: 'o3-mini', label: 'o3-mini', hint: 'reasoning model' },
  ],
  google: [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'most capable' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'faster' },
  ],
};

const ENV_VAR_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

// Providers that support OAuth login
const OAUTH_PROVIDERS = new Set(['openai', 'google']);

export async function cerebrumStep(): Promise<CerebrumResult> {
  const provider = guardCancel(
    await clack.select({
      message: 'LLM Provider',
      options: [
        { value: 'anthropic', label: 'Anthropic (Claude)' },
        { value: 'openai', label: 'OpenAI' },
        { value: 'google', label: 'Google (Gemini)' },
        { value: 'local', label: 'Local (Ollama / vLLM)' },
      ],
    }),
  ) as string;

  let apiKey: CerebrumResult['apiKey'];
  let localBaseUrl: string | undefined;
  let auth: CerebrumResult['auth'];
  let oauthClientId: string | undefined;
  let oauthClientSecret: string | undefined;

  if (provider === 'local') {
    localBaseUrl = guardCancel(
      await clack.text({
        message: 'Local LLM base URL',
        initialValue: 'http://localhost:11434',
        validate: (v) => (v.startsWith('http') ? undefined : 'Must be a valid URL'),
      }),
    ) as string;
  } else {
    // Ask auth method for providers that support OAuth
    let authMethod: string = 'apikey';
    if (OAUTH_PROVIDERS.has(provider)) {
      authMethod = guardCancel(
        await clack.select({
          message: 'Authentication method',
          options: [
            { value: 'apikey', label: 'API Key', hint: 'traditional sk-... key' },
            { value: 'oauth', label: 'OAuth (Browser Login)', hint: 'sign in with your account' },
          ],
        }),
      ) as string;
    }

    if (authMethod === 'oauth') {
      auth = 'oauth';
      clack.log.warn(
        'OAuth uses shared credentials and may trigger account restrictions from the provider.\n'
        + '  Use an API key if this is a production or high-volume setup.',
      );
      const proceed = guardCancel(
        await clack.confirm({ message: 'Continue with OAuth?', initialValue: true }),
      );
      if (!proceed) {
        authMethod = 'apikey';
      }
    }

    if (authMethod === 'oauth') {
      clack.log.info('Opening browser for sign-in...');

      try {
        const loginFn = provider === 'openai' ? loginOpenAI : loginGoogle;
        const tokens = await loginFn({
          onAuth: (url) => {
            const cmd =
              platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
            exec(`${cmd} ${JSON.stringify(url)}`);
            clack.log.info(`If the browser didn't open, visit:\n  ${url}`);
          },
          onPrompt: async (message) => {
            return guardCancel(
              await clack.text({ message, validate: (v) => (v.length > 0 ? undefined : 'Required') }),
            ) as string;
          },
          onProgress: (msg) => clack.log.step(msg),
        });

        const store = new TokenStore();
        store.save(provider, tokens);
        clack.log.success(`Authenticated with ${provider}!`);
      } catch (err) {
        clack.log.error(`OAuth failed: ${err instanceof Error ? err.message : err}`);
        clack.log.warn('You can retry later with: cereworker auth ' + provider);
      }
    } else {
      auth = 'apikey';
      const envVar = ENV_VAR_MAP[provider];
      const envValue = process.env[envVar];

      if (envValue) {
        const useEnv = guardCancel(
          await clack.confirm({
            message: `Found ${envVar} in environment. Use it?`,
            initialValue: true,
          }),
        );

        if (useEnv) {
          apiKey = { envRef: envVar };
        }
      }

      if (!apiKey) {
        const keyMode = guardCancel(
          await clack.select({
            message: 'How to store the API key?',
            options: [
              { value: 'env', label: `Reference env var (\${${envVar}})`, hint: 'recommended' },
              { value: 'plain', label: 'Store directly in config', hint: 'less secure' },
            ],
          }),
        ) as string;

        if (keyMode === 'env') {
          if (!envValue) {
            clack.log.warn(`Set ${envVar} in your shell profile before running CereWorker.`);
          }
          apiKey = { envRef: envVar };
        } else {
          const key = guardCancel(
            await clack.text({
              message: `Enter your ${provider} API key`,
              validate: (v) => (v.length > 0 ? undefined : 'API key is required'),
            }),
          ) as string;
          apiKey = { plaintext: key };
        }
      }
    }
  }

  // Model selection
  let model: string;

  if (provider === 'local') {
    model = guardCancel(
      await clack.text({
        message: 'Model name',
        initialValue: 'llama3',
        placeholder: 'e.g., llama3, codellama, mistral',
      }),
    ) as string;
  } else {
    const models = PROVIDER_MODELS[provider] ?? [];
    const modelOptions = [
      ...models,
      { value: '__custom__', label: 'Other (enter model ID)' },
    ];

    const selected = guardCancel(
      await clack.select({
        message: 'Model',
        options: modelOptions,
      }),
    ) as string;

    if (selected === '__custom__') {
      model = guardCancel(
        await clack.text({
          message: 'Enter model ID',
          validate: (v) => (v.length > 0 ? undefined : 'Model ID is required'),
        }),
      ) as string;
    } else {
      model = selected;
    }
  }

  return { provider, model, apiKey, localBaseUrl, auth, oauthClientId, oauthClientSecret };
}
