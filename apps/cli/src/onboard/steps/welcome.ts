import { existsSync, unlinkSync } from 'node:fs';
import { GLOBAL_CONFIG, loadConfig } from '@cereworker/config';
import { clack, guardCancel } from '../prompter.js';

export interface WelcomeResult {
  action: 'fresh' | 'update';
  existingRaw: Record<string, unknown> | null;
}

export async function welcomeStep(): Promise<WelcomeResult> {
  clack.intro('CereWorker Onboarding');

  if (!existsSync(GLOBAL_CONFIG)) {
    clack.log.info('No config found. Starting fresh setup.');
    return { action: 'fresh', existingRaw: null };
  }

  // Parse existing config for display
  let existingRaw: Record<string, unknown> | null = null;
  try {
    const config = loadConfig();
    existingRaw = config as unknown as Record<string, unknown>;
  } catch {
    existingRaw = null;
  }

  if (existingRaw) {
    const cerebrum = existingRaw.cerebrum as Record<string, unknown> | undefined;
    const summary = [
      cerebrum?.defaultProvider ? `Provider: ${cerebrum.defaultProvider}` : null,
      cerebrum?.defaultModel ? `Model: ${cerebrum.defaultModel}` : null,
    ]
      .filter(Boolean)
      .join(', ');

    if (summary) {
      clack.log.info(`Existing config found: ${summary}`);
    } else {
      clack.log.info('Existing config found at ~/.cereworker/config.yaml');
    }
  }

  const action = guardCancel(
    await clack.select({
      message: 'What would you like to do?',
      options: [
        { value: 'update' as const, label: 'Update existing config' },
        { value: 'fresh' as const, label: 'Start fresh (reset config)' },
        { value: 'keep' as const, label: 'Keep current config and exit' },
      ],
    }),
  );

  if (action === 'keep') {
    clack.outro('Config unchanged.');
    process.exit(0);
  }

  if (action === 'fresh') {
    unlinkSync(GLOBAL_CONFIG);
    clack.log.info('Config reset. Starting fresh.');
    return { action: 'fresh', existingRaw: null };
  }

  return { action: 'update', existingRaw };
}
