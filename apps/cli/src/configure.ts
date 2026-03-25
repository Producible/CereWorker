import { randomBytes } from 'node:crypto';
import { loadRawConfig, GLOBAL_CONFIG, writeConfig } from '@cereworker/config';
import { profileStep } from './onboard/steps/profile.js';
import { clack, guardCancel } from './onboard/prompter.js';

export async function runConfigureProfile(): Promise<void> {
  const raw = loadRawConfig();
  const existing = raw.profile as { name?: string; role?: string; traits?: string[] } | undefined;

  if (existing) {
    clack.log.info(`Current profile: ${existing.name ?? 'Cere'} — ${existing.role ?? 'general-purpose assistant'}`);
    if (existing.traits?.length) {
      clack.log.info(`Traits: ${existing.traits.join(', ')}`);
    }
    clack.log.step('');
  }

  const profile = await profileStep();

  raw.profile = {
    name: profile.name,
    role: profile.role,
    ...(profile.traits.length > 0 ? { traits: profile.traits } : {}),
  };

  writeConfig(raw);
  clack.outro(`Profile updated in ${GLOBAL_CONFIG}`);
}

const PROVIDER_MODELS: Record<string, { value: string; label: string; hint?: string }[]> = {
  anthropic: [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'default, best balance of speed and intelligence' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', hint: 'most capable, best for agents and coding' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', hint: 'fastest, cheapest' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', hint: 'previous gen, proven' },
    { value: 'claude-opus-4-5', label: 'Claude Opus 4.5', hint: 'previous gen Opus' },
  ],
  openai: [
    { value: 'gpt-5.4', label: 'GPT-5.4', hint: 'default, frontier intelligence, 1M context' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini', hint: 'fast, cost efficient, 400K context' },
    { value: 'o3', label: 'o3', hint: 'most powerful reasoning model' },
    { value: 'o4-mini', label: 'o4-mini', hint: 'efficient reasoning, half the cost of o3' },
    { value: 'gpt-4.1', label: 'GPT-4.1', hint: '1M context, strong coding' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', hint: '1M context, fast' },
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', hint: '1M context, cheapest' },
  ],
  google: [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'default, deep reasoning' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'best price-performance, 1M context' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', hint: 'fastest, cheapest' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)', hint: 'next gen, advanced agentic' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)', hint: 'next gen, frontier-class' },
  ],
};

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'local', label: 'Local (Ollama / vLLM)' },
];

export async function runConfigureBrowser(): Promise<void> {
  const raw = loadRawConfig();
  const tools = (raw.tools ?? {}) as Record<string, unknown>;
  const browser = (tools.browser ?? {}) as Record<string, unknown>;
  const ext = (browser.extension ?? {}) as Record<string, unknown>;

  const currentMode = (browser.mode as string) ?? 'launch';
  const currentEnabled = browser.enabled !== false;

  clack.log.info(`Current: mode=${currentMode}, enabled=${currentEnabled}`);

  const mode = guardCancel(
    await clack.select({
      message: 'Browser mode',
      options: [
        { value: 'extension', label: 'Extension', hint: 'control your real Chrome via extension' },
        { value: 'launch', label: 'Launch', hint: 'headless Puppeteer (default)' },
        { value: 'connect', label: 'Connect', hint: 'attach to running Chrome via CDP' },
        { value: 'disabled', label: 'Disabled', hint: 'turn off browser tools' },
      ],
      initialValue: currentEnabled ? currentMode : 'disabled',
    }),
  ) as string;

  if (mode === 'disabled') {
    browser.enabled = false;
    tools.browser = browser;
    raw.tools = tools;
    writeConfig(raw);
    clack.outro(`Browser tools disabled in ${GLOBAL_CONFIG}`);
    return;
  }

  browser.enabled = true;
  browser.mode = mode;

  if (mode === 'extension') {
    const relayPort = guardCancel(
      await clack.text({
        message: 'Relay port',
        initialValue: String(ext.relayPort ?? 18900),
        validate: (v) => (/^\d+$/.test(v) ? undefined : 'Must be a number'),
      }),
    ) as string;

    const currentToken = (ext.token as string) ?? '';
    const generateNew = !currentToken;
    const token = guardCancel(
      await clack.text({
        message: 'Shared token (leave empty to auto-generate)',
        initialValue: currentToken,
        placeholder: generateNew ? 'will auto-generate' : undefined,
      }),
    ) as string;

    ext.relayPort = parseInt(relayPort, 10);
    ext.token = token || randomBytes(16).toString('hex');
    browser.extension = ext;

    clack.log.info(`Extension relay: port ${ext.relayPort}, token ${ext.token}`);
  }

  if (mode === 'connect') {
    const cdpPort = guardCancel(
      await clack.text({
        message: 'CDP port',
        initialValue: String(browser.cdpPort ?? 9222),
        validate: (v) => (/^\d+$/.test(v) ? undefined : 'Must be a number'),
      }),
    ) as string;
    browser.cdpPort = parseInt(cdpPort, 10);
  }

  tools.browser = browser;
  raw.tools = tools;
  writeConfig(raw);
  clack.outro(`Browser mode set to "${mode}" in ${GLOBAL_CONFIG}`);
}

export async function runConfigureModel(): Promise<void> {
  const raw = loadRawConfig();
  const cerebrum = raw.cerebrum as { defaultProvider?: string; defaultModel?: string } | undefined;
  const currentProvider = cerebrum?.defaultProvider ?? 'anthropic';
  const currentModel = cerebrum?.defaultModel ?? 'claude-sonnet-4-6';

  clack.log.info(`Current: ${currentProvider} / ${currentModel}`);

  const provider = guardCancel(
    await clack.select({
      message: 'LLM Provider',
      options: PROVIDERS,
      initialValue: currentProvider,
    }),
  ) as string;

  let model: string;

  if (provider === 'local') {
    model = guardCancel(
      await clack.text({
        message: 'Model name',
        initialValue: currentProvider === 'local' ? currentModel : 'llama3.3',
        placeholder: 'e.g., llama3.3, qwen3, codellama, mistral',
      }),
    ) as string;
  } else {
    const models = PROVIDER_MODELS[provider] ?? [];
    const selected = guardCancel(
      await clack.select({
        message: 'Model',
        options: [
          ...models,
          { value: '__custom__', label: 'Other (enter model ID)' },
        ],
        initialValue: provider === currentProvider ? currentModel : undefined,
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

  if (!raw.cerebrum) raw.cerebrum = {};
  (raw.cerebrum as Record<string, unknown>).defaultProvider = provider;
  (raw.cerebrum as Record<string, unknown>).defaultModel = model;

  writeConfig(raw);
  clack.outro(`Model set to ${provider} / ${model} in ${GLOBAL_CONFIG}`);
}
