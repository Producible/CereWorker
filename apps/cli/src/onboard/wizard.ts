import { welcomeStep } from './steps/welcome.js';
import { cerebrumStep } from './steps/cerebrum.js';
import { cerebellumStep } from './steps/cerebellum.js';
import { channelsStep } from './steps/channels.js';
import { summaryStep } from './steps/summary.js';

export async function runOnboardingWizard(): Promise<void> {
  const welcome = await welcomeStep();
  const cerebrum = await cerebrumStep();
  const cerebellum = await cerebellumStep();
  const channels = await channelsStep();
  await summaryStep({
    cerebrum,
    cerebellum,
    channels,
    existingConfig: welcome.existingRaw,
  });
}
