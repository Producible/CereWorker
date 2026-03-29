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
  const { cerebrumStep } = await import('./onboard/steps/cerebrum.js');

  const raw = loadRawConfig();
  const cerebrum = raw.cerebrum as Record<string, unknown> | undefined;
  clack.log.info(`Current: ${cerebrum?.defaultProvider ?? 'anthropic'} / ${cerebrum?.defaultModel ?? 'claude-sonnet-4-6'}`);

  const result = await cerebrumStep();

  // Write cerebrum settings from onboarding result into existing config
  if (!raw.cerebrum) raw.cerebrum = {};
  const cfg = raw.cerebrum as Record<string, unknown>;
  cfg.defaultProvider = result.provider;
  cfg.defaultModel = result.model;

  // Handle API key
  if (result.apiKey) {
    if (!cfg.providers) cfg.providers = {};
    const providers = cfg.providers as Record<string, Record<string, unknown>>;
    if (!providers[result.provider]) providers[result.provider] = {};
    if ('envRef' in result.apiKey) {
      providers[result.provider].apiKey = `\${${result.apiKey.envRef}}`;
    } else {
      providers[result.provider].apiKey = result.apiKey.plaintext;
    }
  }

  // Handle auth method
  if (result.auth) {
    if (!cfg.providers) cfg.providers = {};
    const providers = cfg.providers as Record<string, Record<string, unknown>>;
    if (!providers[result.provider]) providers[result.provider] = {};
    providers[result.provider].auth = result.auth;
  }

  // Handle provider base URL
  if (result.baseUrl) {
    if (!cfg.providers) cfg.providers = {};
    const providers = cfg.providers as Record<string, Record<string, unknown>>;
    if (!providers[result.provider]) providers[result.provider] = {};
    providers[result.provider].baseUrl = result.baseUrl;
  }

  writeConfig(raw);
  clack.outro(`Cerebrum set to ${result.provider} / ${result.model} in ${GLOBAL_CONFIG}`);
}
