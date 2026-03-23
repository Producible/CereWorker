import { welcomeStep } from './steps/welcome.js';
import { profileStep } from './steps/profile.js';
import { cerebrumStep } from './steps/cerebrum.js';
import { cerebellumStep } from './steps/cerebellum.js';
import { channelsStep } from './steps/channels.js';
import { gatewayStep } from './steps/gateway.js';
import { summaryStep } from './steps/summary.js';
import { clack, guardCancel } from './prompter.js';

export async function runOnboardingWizard(): Promise<void> {
  const welcome = await welcomeStep();
  const profile = await profileStep();
  const cerebrum = await cerebrumStep();
  const cerebellum = await cerebellumStep();

  const configureChannels = guardCancel(
    await clack.confirm({
      message: 'Configure messaging channels (Slack, Discord, Telegram, etc.)?',
      initialValue: false,
    }),
  );
  const channelsResult = configureChannels
    ? await channelsStep()
    : { channels: [], dmPolicy: 'pairing' as const };

  const configureGateway = guardCancel(
    await clack.confirm({
      message: 'Configure gateway mode (multi-node control)?',
      initialValue: false,
    }),
  );
  const gateway = configureGateway
    ? await gatewayStep()
    : { mode: 'standalone' as const };

  await summaryStep({
    profile,
    cerebrum,
    cerebellum,
    channels: channelsResult.channels,
    dmPolicy: channelsResult.dmPolicy,
    gateway,
    existingConfig: welcome.existingRaw,
  });
}
