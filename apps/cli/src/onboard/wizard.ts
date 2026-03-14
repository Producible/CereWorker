import { welcomeStep } from './steps/welcome.js';
import { cerebrumStep } from './steps/cerebrum.js';
import { cerebellumStep } from './steps/cerebellum.js';
import { channelsStep } from './steps/channels.js';
import { summaryStep } from './steps/summary.js';
import { clack, guardCancel } from './prompter.js';

export async function runOnboardingWizard(): Promise<void> {
  const welcome = await welcomeStep();
  const cerebrum = await cerebrumStep();
  const cerebellum = await cerebellumStep();

  const configureChannels = guardCancel(
    await clack.confirm({
      message: 'Configure messaging channels (Slack, Discord, Telegram, etc.)?',
      initialValue: false,
    }),
  );
  const channels = configureChannels ? await channelsStep() : [];

  await summaryStep({
    cerebrum,
    cerebellum,
    channels,
    existingConfig: welcome.existingRaw,
  });
}
