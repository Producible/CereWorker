import { GLOBAL_CONFIG, writeConfig } from '@cereworker/config';
import { clack, guardCancel } from '../prompter.js';
import { buildConfig, type BuildConfigParams } from '../config-builder.js';

export async function summaryStep(params: BuildConfigParams): Promise<void> {
  const lines: string[] = [];

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

  lines.push(`Config path:  ${GLOBAL_CONFIG}`);

  clack.note(lines.join('\n'), 'Summary');

  const confirm = guardCancel(
    await clack.confirm({
      message: 'Write this config?',
      initialValue: true,
    }),
  );

  if (!confirm) {
    clack.outro('Config not written. Run `cereworker onboard` again to restart.');
    process.exit(0);
  }

  const config = buildConfig(params);
  writeConfig(config);

  clack.outro(`Config saved to ${GLOBAL_CONFIG}. Run \`cereworker\` to start.`);
}
