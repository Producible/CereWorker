import { clack, guardCancel } from '../prompter.js';
import {
  getCerebrumProvider,
  getCerebrumProviderFamily,
  getProviderAuthModes,
  getProviderEndpointOptions,
  getProviderEnvVar,
  getProviderModels,
  listCerebrumProviderFamilies,
  type ProviderAuthMode,
} from '@producible/cereworker-config';
import { loginGoogle, loginMiniMaxPortal, loginOpenAICodex, TokenStore } from '@producible/cereworker-cerebrum';
import { openBrowser } from '../../open-browser.js';

export interface CerebrumResult {
  provider: string;
  model: string;
  apiKey?: { envRef: string } | { plaintext: string };
  baseUrl?: string;
  auth?: 'apikey' | 'oauth';
}

export type CerebrumAuthMode = ProviderAuthMode;

export function getSupportedAuthModes(provider: string): CerebrumAuthMode[] {
  return getProviderAuthModes(provider);
}

export function resolveProviderSelectionFamily(family: string): string | undefined {
  const providers = getCerebrumProviderFamily(family);
  if (providers.length === 1) {
    return providers[0]?.id;
  }
  return undefined;
}

export async function cerebrumStep(): Promise<CerebrumResult> {
  const availableFamilies = listCerebrumProviderFamilies();
  const family = guardCancel(
    await clack.select({
      message: 'LLM Provider',
      options: availableFamilies.map((entry) => ({
        value: entry.id,
        label: entry.label,
        hint: entry.hint,
      })),
    }),
  ) as string;
  const familyProviders = getCerebrumProviderFamily(family);
  const provider = resolveProviderSelectionFamily(family)
    ?? guardCancel(
      await clack.select({
        message: `${familyProviders[0]?.familyLabel ?? 'Provider'} Type`,
        options: familyProviders.map((entry) => ({
          value: entry.id,
          label: entry.typeLabel ?? entry.label,
          hint: entry.authModes.includes('oauth') ? 'OAuth' : 'API key',
        })),
      }),
    ) as string;
  const providerDefinition = getCerebrumProvider(provider);
  if (!providerDefinition) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  let apiKey: CerebrumResult['apiKey'];
  let baseUrl: string | undefined;
  let auth: CerebrumResult['auth'];

  if (provider === 'local') {
    baseUrl = guardCancel(
      await clack.text({
        message: 'Local LLM base URL',
        initialValue: 'http://localhost:11434',
        validate: (v) => (v.startsWith('http') ? undefined : 'Must be a valid URL'),
      }),
    ) as string;
  } else {
    const endpointOptions = getProviderEndpointOptions(provider);
    if (endpointOptions.length > 0) {
      const selectedEndpoint = guardCancel(
        await clack.select({
          message: 'Endpoint',
          options: endpointOptions.map((option) => ({
            value: option.baseUrl,
            label: option.label,
            hint: option.hint,
          })),
        }),
      ) as string;
      baseUrl = selectedEndpoint;
    }

    const supportedAuthModes = getSupportedAuthModes(provider);
    let authMethod: CerebrumAuthMode = supportedAuthModes[0] ?? 'apikey';

    if (supportedAuthModes.length > 1) {
      authMethod = guardCancel(
        await clack.select({
          message: 'Authentication method',
          options: [
            { value: 'apikey', label: 'API Key', hint: 'traditional sk-... key' },
            { value: 'oauth', label: 'OAuth (Browser Login)', hint: 'sign in with your account' },
          ],
        }),
      ) as CerebrumAuthMode;
    }

    if (authMethod === 'oauth') {
      auth = 'oauth';
      if (provider === 'openai-codex') {
        clack.log.info('OpenAI Codex uses your ChatGPT/Codex subscription via browser login.');
      } else if (provider === 'minimax-portal') {
        clack.log.info('MiniMax Portal uses browser/device approval through your MiniMax account.');
      } else if (provider === 'google') {
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
    }

    if (authMethod === 'oauth') {
      clack.log.info('Opening browser for sign-in...');

      try {
        const commonCallbacks = {
          onAuth: (url: string) => {
            openBrowser(url);
            clack.log.info(`If the browser didn't open, visit:\n  ${url}`);
          },
          onPrompt: async (message: string) => {
            return guardCancel(
              await clack.text({ message, validate: (v) => (v.length > 0 ? undefined : 'Required') }),
            ) as string;
          },
          onProgress: (msg: string) => clack.log.step(msg),
        };
        const tokens = provider === 'openai-codex'
          ? await loginOpenAICodex(commonCallbacks)
          : provider === 'google'
            ? await loginGoogle(commonCallbacks)
            : await loginMiniMaxPortal({
                ...commonCallbacks,
                baseUrl,
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
      const envVar = getProviderEnvVar(provider);
      if (!envVar) {
        throw new Error(`No API key env var configured for provider: ${provider}`);
      }
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
              message: `Enter your ${providerDefinition.familyLabel} API key`,
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
        initialValue: 'llama3.3',
        placeholder: 'e.g., llama3.3, qwen3, codellama, mistral',
      }),
    ) as string;
  } else {
    const models = getProviderModels(provider);
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

  return { provider, model, apiKey, baseUrl, auth };
}
