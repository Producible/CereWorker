import { GLOBAL_CONFIG, writeConfig } from '@cereworker/config';
import { clack, guardCancel } from '../prompter.js';
import { buildConfig, type BuildConfigParams } from '../config-builder.js';

export function getChannelInstructions(channelId: string): string {
  switch (channelId) {
    case 'telegram':
      return 'Telegram: CereWorker uses polling automatically. Message your bot to start chatting.';
    case 'discord':
      return 'Discord: Invite your bot using the OAuth2 URL from the Developer Portal.';
    case 'slack':
      return 'Slack: Socket Mode is enabled — no webhook or public URL needed. Just start CereWorker.';
    case 'matrix':
      return 'Matrix: Invite the bot to any room you want it to join.';
    case 'feishu':
      return 'Feishu: Approve the bot in your admin console before messaging it.';
    case 'wechat':
      return 'WeChat: Start CereWorker and scan the QR code to link the bot.';
    default:
      return `${channelId}: See documentation for setup instructions`;
  }
}

export async function summaryStep(params: BuildConfigParams): Promise<void> {
  const lines: string[] = [];

  // Profile
  if (params.profile) {
    lines.push(`Name:         ${params.profile.name}`);
    lines.push(`Role:         ${params.profile.role}`);
    if (params.profile.traits.length > 0) {
      lines.push(`Traits:       ${params.profile.traits.join(', ')}`);
    }
    lines.push('');
  }

  // Cerebrum
  lines.push(`Provider:     ${params.cerebrum.provider}`);
  lines.push(`Model:        ${params.cerebrum.model}`);
  if (params.cerebrum.apiKey) {
    if ('envRef' in params.cerebrum.apiKey) {
      lines.push(`API key:      via $${params.cerebrum.apiKey.envRef}`);
    } else {
      lines.push(`API key:      stored in config`);
    }
  }

  // Cerebellum
  if (params.cerebellum.enabled) {
    const modelName = params.cerebellum.model?.id ?? params.cerebellum.model?.path ?? 'default';
    lines.push(`Cerebellum:   enabled (${modelName})`);
    if (params.cerebellum.finetune?.enabled) {
      lines.push(`Fine-tune:    ${params.cerebellum.finetune.method} / ${params.cerebellum.finetune.schedule}`);
    }
    lines.push(`Docker:       ${params.cerebellum.dockerAutoStart ? 'auto-start' : 'manual'}`);
  } else {
    lines.push(`Cerebellum:   disabled`);
  }

  // Channels
  if (params.channels.length > 0) {
    lines.push(`Channels:     ${params.channels.map((c) => c.id).join(', ')}`);
  } else {
    lines.push(`Channels:     none`);
  }

  // Gateway
  if (params.gateway && params.gateway.mode !== 'standalone') {
    if (params.gateway.mode === 'gateway') {
      lines.push(`Gateway:      hub on port ${params.gateway.port ?? 18800}`);
    } else {
      lines.push(`Gateway:      node → ${params.gateway.gatewayUrl} (${params.gateway.nodeId})`);
    }
  } else {
    lines.push(`Gateway:      standalone`);
  }

  lines.push(`Config path:  ${GLOBAL_CONFIG}`);

  clack.note(lines.join('\n'), 'Summary');

  // Only ask for confirmation when updating existing config
  if (params.existingConfig) {
    const confirm = guardCancel(
      await clack.confirm({
        message: 'Overwrite existing config?',
        initialValue: true,
      }),
    );

    if (!confirm) {
      clack.outro('Config not written. Run `cereworker onboard` again to restart.');
      process.exit(0);
    }
  }

  const config = buildConfig(params);
  writeConfig(config);

  // Next steps guidance
  const nextSteps: string[] = [];

  // Channel-specific setup instructions
  for (const ch of params.channels) {
    nextSteps.push(getChannelInstructions(ch.id));
  }

  // Cerebellum guidance
  if (params.cerebellum.enabled) {
    if (params.cerebellum.dockerAutoStart) {
      nextSteps.push('Cerebellum: Docker container will auto-start with cereworker.');
    } else {
      nextSteps.push('Cerebellum: Start manually with `docker compose up -d cerebellum`');
    }
  }

  // Gateway guidance
  if (params.gateway?.mode === 'gateway') {
    nextSteps.push(`Gateway: Hub will listen on port ${params.gateway.port ?? 18800}. Nodes can connect once running.`);
  } else if (params.gateway?.mode === 'node') {
    nextSteps.push(`Gateway: Ensure hub at ${params.gateway.gatewayUrl} is running before starting.`);
  }

  // General next steps (always shown)
  nextSteps.push('');
  nextSteps.push('Run `cereworker` to start the TUI.');
  nextSteps.push('Run `cereworker serve` for headless mode (servers/systemd).');

  clack.note(nextSteps.join('\n'), 'Next Steps');

  clack.outro(`Config saved to ${GLOBAL_CONFIG}`);
}
