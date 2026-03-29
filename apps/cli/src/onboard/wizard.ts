import { welcomeStep } from './steps/welcome.js';
import { cerebrumStep } from './steps/cerebrum.js';
import { cerebellumStep } from './steps/cerebellum.js';
import { channelsStep } from './steps/channels.js';
import { gatewayStep } from './steps/gateway.js';
import { summaryStep } from './steps/summary.js';
import { clack, guardCancel } from './prompter.js';
import {
  getCurrentCerebellumConfig,
  getCurrentCerebrumConfig,
  getCurrentChannelsConfig,
  getCurrentGatewayConfig,
  summarizeCerebellumConfig,
  summarizeCerebrumConfig,
  summarizeChannelsConfig,
  summarizeGatewayConfig,
} from './existing-config.js';

async function resolveOnboardingSection<T>(
  label: string,
  summary: string,
  currentValue: T,
  reconfigure: () => Promise<T>,
): Promise<T> {
  clack.log.info(`Current ${label}: ${summary}`);
  const keepCurrent = guardCancel(
    await clack.confirm({
      message: `Keep current ${label} configuration?`,
      initialValue: true,
    }),
  );
  return keepCurrent ? currentValue : reconfigure();
}

export async function runOnboardingWizard(): Promise<void> {
  const welcome = await welcomeStep();
  const existingConfig = welcome.existingConfig;
  const existingRaw = welcome.existingRaw;
  const canReuseExisting = welcome.action === 'update' && existingConfig !== null && existingRaw !== null;

  const cerebrum = canReuseExisting
    ? await (() => {
        const current = getCurrentCerebrumConfig(existingConfig, existingRaw);
        return resolveOnboardingSection(
          'Cerebrum',
          summarizeCerebrumConfig(current),
          current,
          () => cerebrumStep(),
        );
      })()
    : await cerebrumStep();

  const cerebellum = canReuseExisting
    ? await (() => {
        const current = getCurrentCerebellumConfig(existingConfig, existingRaw);
        return resolveOnboardingSection(
          'Cerebellum',
          summarizeCerebellumConfig(current),
          current,
          () => cerebellumStep(),
        );
      })()
    : await cerebellumStep();

  const channelsResult = canReuseExisting
    ? await (() => {
        const current = getCurrentChannelsConfig(existingConfig, existingRaw);
        return resolveOnboardingSection(
          'messaging channels',
          summarizeChannelsConfig(current),
          current,
          () => channelsStep(),
        );
      })()
    : guardCancel(
        await clack.confirm({
          message: 'Configure messaging channels (Slack, Discord, Telegram, etc.)?',
          initialValue: false,
        }),
      )
      ? await channelsStep()
      : { channels: [], dmPolicy: 'pairing' as const };

  const gateway = canReuseExisting
    ? await (() => {
        const current = getCurrentGatewayConfig(existingConfig, existingRaw);
        return resolveOnboardingSection(
          'gateway',
          summarizeGatewayConfig(current),
          current,
          () => gatewayStep(),
        );
      })()
    : guardCancel(
        await clack.confirm({
          message: 'Configure gateway mode (multi-node control)?',
          initialValue: false,
        }),
      )
      ? await gatewayStep()
      : { mode: 'standalone' as const };

  await summaryStep({
    cerebrum,
    cerebellum,
    channels: channelsResult.channels,
    dmPolicy: channelsResult.dmPolicy,
    gateway,
    existingConfig: existingRaw,
  });
}
