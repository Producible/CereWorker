import { clack, guardCancel } from '../prompter.js';

export interface ChannelSetup {
  id: string;
  credentials: Record<string, string | { envRef: string }>;
}

interface ChannelDef {
  id: string;
  label: string;
  fields: { key: string; label: string; required: boolean; envVar: string; defaultValue?: string }[];
}

const CHANNEL_DEFS: ChannelDef[] = [
  {
    id: 'slack',
    label: 'Slack',
    fields: [
      { key: 'botToken', label: 'Bot token', required: true, envVar: 'SLACK_BOT_TOKEN' },
      { key: 'appToken', label: 'App token', required: true, envVar: 'SLACK_APP_TOKEN' },
    ],
  },
  {
    id: 'discord',
    label: 'Discord',
    fields: [
      { key: 'token', label: 'Bot token', required: true, envVar: 'DISCORD_TOKEN' },
    ],
  },
  {
    id: 'telegram',
    label: 'Telegram',
    fields: [
      { key: 'token', label: 'Bot token', required: true, envVar: 'TELEGRAM_BOT_TOKEN' },
    ],
  },
  {
    id: 'matrix',
    label: 'Matrix',
    fields: [
      { key: 'homeserver', label: 'Homeserver URL', required: true, envVar: '', defaultValue: 'https://matrix.org' },
      { key: 'token', label: 'Access token', required: true, envVar: 'MATRIX_TOKEN' },
      { key: 'userId', label: 'User ID (e.g., @bot:matrix.org)', required: true, envVar: '' },
    ],
  },
  {
    id: 'feishu',
    label: 'Feishu (Lark)',
    fields: [
      { key: 'appId', label: 'App ID', required: true, envVar: 'FEISHU_APP_ID' },
      { key: 'appSecret', label: 'App Secret', required: true, envVar: 'FEISHU_APP_SECRET' },
    ],
  },
  {
    id: 'wechat',
    label: 'WeChat',
    fields: [
      { key: 'puppet', label: 'Puppet provider', required: true, envVar: '', defaultValue: 'wechaty-puppet-wechat4u' },
    ],
  },
];

export async function channelsStep(): Promise<ChannelSetup[]> {
  const selected = guardCancel(
    await clack.multiselect({
      message: 'Enable messaging channels (space to select, enter to confirm)',
      options: CHANNEL_DEFS.map((ch) => ({
        value: ch.id,
        label: ch.label,
      })),
      required: false,
    }),
  ) as string[];

  if (selected.length === 0) {
    return [];
  }

  const setups: ChannelSetup[] = [];

  for (const channelId of selected) {
    const def = CHANNEL_DEFS.find((d) => d.id === channelId)!;
    clack.log.step(`Configure ${def.label}`);

    const credentials: Record<string, string | { envRef: string }> = {};

    for (const field of def.fields) {
      if (field.defaultValue && !field.envVar) {
        // Non-secret field with a default
        const value = guardCancel(
          await clack.text({
            message: field.label,
            initialValue: field.defaultValue,
          }),
        ) as string;
        credentials[field.key] = value;
        continue;
      }

      if (!field.envVar) {
        // Non-secret field without a default
        const value = guardCancel(
          await clack.text({
            message: field.label,
            validate: field.required ? (v) => (v.length > 0 ? undefined : `${field.label} is required`) : undefined,
          }),
        ) as string;
        credentials[field.key] = value;
        continue;
      }

      // Secret field — offer env var ref
      const envValue = process.env[field.envVar];
      if (envValue) {
        const useEnv = guardCancel(
          await clack.confirm({
            message: `Found ${field.envVar} in environment. Use it?`,
            initialValue: true,
          }),
        );
        if (useEnv) {
          credentials[field.key] = { envRef: field.envVar };
          continue;
        }
      }

      const mode = guardCancel(
        await clack.select({
          message: `How to store ${field.label}?`,
          options: [
            { value: 'env', label: `Reference env var (\${${field.envVar}})`, hint: 'recommended' },
            { value: 'plain', label: 'Store directly in config' },
          ],
        }),
      ) as string;

      if (mode === 'env') {
        if (!envValue) {
          clack.log.warn(`Set ${field.envVar} in your shell profile before running CereWorker.`);
        }
        credentials[field.key] = { envRef: field.envVar };
      } else {
        const value = guardCancel(
          await clack.text({
            message: `Enter ${field.label}`,
            validate: field.required ? (v) => (v.length > 0 ? undefined : `${field.label} is required`) : undefined,
          }),
        ) as string;
        credentials[field.key] = value;
      }
    }

    setups.push({ id: channelId, credentials });
  }

  return setups;
}
