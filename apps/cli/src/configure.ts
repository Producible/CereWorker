import { loadRawConfig, GLOBAL_CONFIG, writeConfig } from '@cereworker/config';
import { profileStep } from './onboard/steps/profile.js';
import { clack } from './onboard/prompter.js';

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
