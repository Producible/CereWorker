import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { welcomeStep } from './steps/welcome.js';
import { profileStep } from './steps/profile.js';
import { discoveryStep } from './steps/discovery.js';
import { cerebrumStep } from './steps/cerebrum.js';
import { cerebellumStep } from './steps/cerebellum.js';
import { channelsStep } from './steps/channels.js';
import { gatewayStep } from './steps/gateway.js';
import { summaryStep } from './steps/summary.js';
import { clack, guardCancel } from './prompter.js';
import { CerebrumProvider } from '@cereworker/cerebrum';
import { InstanceStore, type TrainingPair } from '@cereworker/core';
import type { CerebrumResult } from './steps/cerebrum.js';

function buildQuickCerebrum(result: CerebrumResult) {
  const apiKey = result.apiKey
    ? ('plaintext' in result.apiKey ? result.apiKey.plaintext : process.env[result.apiKey.envRef])
    : undefined;

  return new CerebrumProvider({
    defaultProvider: result.provider,
    defaultModel: result.model,
    providers: {
      [result.provider]: {
        apiKey,
        baseUrl: result.localBaseUrl,
      },
    },
    maxSteps: 1,
    temperature: 0.7,
  });
}

export async function runOnboardingWizard(): Promise<void> {
  const welcome = await welcomeStep();

  // Check if this is a fresh install (no instance.json) — use discovery mode
  const instancePath = join(homedir(), '.cereworker', 'instance.json');
  const isFreshInstall = !existsSync(instancePath);

  let profile: { name: string; role: string; traits: string[] };
  let discoveryTrainingPairs: TrainingPair[] = [];
  let profileSource: 'static' | 'discovered' = 'static';
  let cerebrum: CerebrumResult;

  if (isFreshInstall) {
    // Fresh install: configure cerebrum first (need LLM for discovery), then discover
    cerebrum = await cerebrumStep();

    const useDiscovery = guardCancel(
      await clack.confirm({
        message: 'Want me to learn about my role through a short conversation? (Recommended)',
        initialValue: true,
      }),
    );

    if (useDiscovery) {
      const quickCerebrum = buildQuickCerebrum(cerebrum);
      const adapter = {
        stream: async (messages: Parameters<typeof quickCerebrum.stream>[0], tools: Parameters<typeof quickCerebrum.stream>[1], callbacks: Parameters<typeof quickCerebrum.stream>[2]) => {
          await quickCerebrum.stream(messages, tools, callbacks);
        },
      };
      const result = await discoveryStep(adapter);
      profile = { name: result.name, role: result.role, traits: result.traits };
      discoveryTrainingPairs = result.trainingPairs;
      profileSource = 'discovered';
    } else {
      profile = await profileStep();
    }
  } else {
    // Existing install: traditional flow
    profile = await profileStep();
    cerebrum = await cerebrumStep();
  }

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

  // Create instance identity after config is saved
  if (isFreshInstall) {
    const instanceStore = new InstanceStore();
    instanceStore.create(profile, profileSource);
    clack.log.success(`Instance identity created (${profileSource})`);
  }

  // Write discovery training pairs to pending.jsonl for first fine-tune
  if (discoveryTrainingPairs.length > 0) {
    try {
      const pendingPath = join(homedir(), '.cereworker', 'finetune', 'pending.jsonl');
      const { mkdirSync, appendFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(pendingPath), { recursive: true });
      for (const pair of discoveryTrainingPairs) {
        appendFileSync(pendingPath, JSON.stringify(pair) + '\n', 'utf-8');
      }
      clack.log.info(`Seeded ${discoveryTrainingPairs.length} training pairs from discovery conversation`);
    } catch {
      // Non-critical — fine-tuning can still work without discovery pairs
    }
  }
}
