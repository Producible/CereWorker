import { execSync, spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { clack, guardCancel } from '../prompter.js';

export function hasGit(): boolean {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function ensureGitForWhatsApp(): Promise<boolean> {
  if (hasGit()) return true;

  clack.log.warn('WhatsApp requires git (the SDK has a git-hosted dependency).');

  const os = platform();
  let installHint = 'Install git manually: https://git-scm.com/downloads';
  let autoInstallCmd: string | null = null;

  if (os === 'linux') {
    // Detect package manager
    if (spawnSync('which', ['apt-get'], { stdio: 'pipe' }).status === 0) {
      installHint = 'sudo apt-get install -y git';
      autoInstallCmd = 'sudo apt-get install -y git';
    } else if (spawnSync('which', ['dnf'], { stdio: 'pipe' }).status === 0) {
      installHint = 'sudo dnf install -y git';
      autoInstallCmd = 'sudo dnf install -y git';
    } else if (spawnSync('which', ['pacman'], { stdio: 'pipe' }).status === 0) {
      installHint = 'sudo pacman -S --noconfirm git';
      autoInstallCmd = 'sudo pacman -S --noconfirm git';
    }
  } else if (os === 'darwin') {
    if (spawnSync('which', ['brew'], { stdio: 'pipe' }).status === 0) {
      installHint = 'brew install git';
      autoInstallCmd = 'brew install git';
    } else {
      installHint = 'xcode-select --install  (or: brew install git)';
    }
  }

  if (!autoInstallCmd) {
    clack.log.warn(`Install git and re-run onboarding. Hint: ${installHint}`);
    clack.log.info('Skipping WhatsApp for now — you can add it later in config.yaml.');
    return false;
  }

  const install = guardCancel(
    await clack.confirm({
      message: `Install git now? (${autoInstallCmd})`,
      active: 'Yes',
      inactive: 'No, I\'ll install it myself',
    }),
  );

  if (install) {
    clack.log.step(`Running: ${autoInstallCmd}`);
    try {
      execSync(autoInstallCmd, { stdio: 'inherit', timeout: 120_000 });
      if (hasGit()) {
        clack.log.success('git installed.');
        return true;
      }
    } catch {
      clack.log.warn('git installation failed.');
    }
  }

  if (!hasGit()) {
    clack.log.warn(`Install git and re-run onboarding. Hint: ${installHint}`);
    clack.log.info('Skipping WhatsApp for now — you can add it later in config.yaml.');
    return false;
  }

  return true;
}

export interface ChannelSetup {
  id: string;
  credentials: Record<string, string | { envRef: string }>;
  allowFrom?: string[];
  channelIds?: string[];
}

export interface ChannelsResult {
  channels: ChannelSetup[];
  dmPolicy: 'pairing' | 'open';
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
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    fields: [],
  },
  {
    id: 'signal',
    label: 'Signal',
    fields: [
      { key: 'account', label: 'Phone number (E.164, e.g. +15551234567)', required: true, envVar: '' },
      { key: 'signalCliUrl', label: 'signal-cli REST URL', required: false, envVar: '', defaultValue: 'http://127.0.0.1:8080' },
    ],
  },
  {
    id: 'irc',
    label: 'IRC',
    fields: [
      { key: 'host', label: 'Server hostname', required: true, envVar: '' },
      { key: 'nick', label: 'Nickname', required: false, envVar: '', defaultValue: 'cereworker' },
    ],
  },
];

const SETUP_GUIDES: Record<string, string> = {
  telegram: [
    '1. Open Telegram and message @BotFather',
    '2. Send /newbot and follow the prompts',
    '3. Copy the bot token BotFather gives you',
    '',
    'Tip: set TELEGRAM_BOT_TOKEN env var to avoid storing in config.',
  ].join('\n'),

  discord: [
    'Create the bot:',
    '  1. Go to discord.com/developers/applications → New Application',
    '  2. Bot tab → Reset Token → copy the token',
    '  3. Enable "Message Content Intent" under Privileged Gateway Intents',
    '',
    'Invite the bot to your server:',
    '  4. OAuth2 → URL Generator → select scopes: "bot", "applications.commands"',
    '  5. Select permissions: View Channels, Send Messages, Read Message History,',
    '     Embed Links, Attach Files (+ Manage Messages for moderation)',
    '  6. Open the generated URL to invite the bot',
    '',
    'Set up channel access:',
    '  7. Go to the target channel → Edit Channel → Permissions',
    '  8. Add the bot role and grant the permissions above',
    '  9. Make sure the bot role is high enough in the server role list',
    '',
    'Tip: enable Developer Mode (Settings → Advanced) to copy channel IDs.',
  ].join('\n'),

  slack: [
    '1. Go to api.slack.com/apps → Create New App → "From a manifest"',
    '2. Paste the manifest shown below',
    '3. Install to workspace',
    '4. Copy Bot Token (xoxb-...) from OAuth & Permissions',
    '5. Copy App Token (xapp-...) from Basic Information → App-Level Tokens',
  ].join('\n'),

  matrix: [
    '1. Create a bot account on your homeserver (e.g., via Element)',
    '2. Log in → Settings → Help & About → Access Token → copy',
    '3. Note the full user ID (e.g., @bot:matrix.org)',
  ].join('\n'),

  feishu: [
    '1. Go to open.feishu.cn → Create Custom App',
    '2. Bot tab → enable bot capability',
    '3. Event Subscriptions → add "im.message.receive_v1"',
    '4. Copy the App ID and App Secret from Credentials',
  ].join('\n'),

  wechat: [
    'WeChat bots use puppet providers (e.g., wechaty-puppet-wechat4u).',
    'See wechaty.js.org for puppet setup instructions.',
  ].join('\n'),

  whatsapp: [
    'WhatsApp connects via WhatsApp Web (no API key needed).',
    'On first run, a QR code will be printed to the terminal.',
    'Scan it with your WhatsApp app to pair.',
    'Credentials are saved to ~/.cereworker/whatsapp-auth/',
    '',
    'Requires: git (the WhatsApp SDK has a git-hosted dependency).',
  ].join('\n'),

  signal: [
    '1. Install signal-cli: github.com/AsamK/signal-cli',
    '2. Register your phone number: signal-cli -u +15551234567 register',
    '3. Start the REST daemon: signal-cli -u +15551234567 daemon --http=8080',
    '4. CereWorker connects to the daemon REST API',
  ].join('\n'),

  irc: [
    '1. Choose an IRC network (e.g., irc.libera.chat)',
    '2. Pick a nickname for your bot',
    '3. Optionally register the nick with NickServ',
    '4. CereWorker connects via TLS (port 6697 by default)',
  ].join('\n'),
};

export function buildSlackManifest(): object {
  return {
    display_information: {
      name: 'CereWorker',
      description: 'CereWorker AI assistant',
    },
    features: {
      bot_user: {
        display_name: 'CereWorker',
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'chat:write',
          'channels:history',
          'im:history',
          'app_mentions:read',
          'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['app_mention', 'message.im', 'message.channels'],
      },
      socket_mode_enabled: true,
      org_deploy_enabled: false,
    },
  };
}

interface ValidationResult {
  ok: boolean;
  display?: string;
  error?: string;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function validateToken(channelId: string, credentials: Record<string, string | { envRef: string }>): Promise<ValidationResult | null> {
  const getPlain = (key: string): string | null => {
    const val = credentials[key];
    return typeof val === 'string' ? val : null;
  };

  try {
    switch (channelId) {
      case 'telegram': {
        const token = getPlain('token');
        if (!token) return null;
        const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getMe`, {});
        const data = await res.json() as { ok: boolean; result?: { username?: string } };
        if (data.ok && data.result?.username) {
          return { ok: true, display: `@${data.result.username}` };
        }
        return { ok: false, error: 'Invalid token or API error' };
      }
      case 'discord': {
        const token = getPlain('token');
        if (!token) return null;
        const res = await fetchWithTimeout('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${token}` },
        });
        const data = await res.json() as { username?: string; message?: string };
        if (data.username) {
          return { ok: true, display: data.username };
        }
        return { ok: false, error: data.message ?? 'Invalid token' };
      }
      case 'slack': {
        const token = getPlain('botToken');
        if (!token) return null;
        const res = await fetchWithTimeout('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as { ok: boolean; team?: string; error?: string };
        if (data.ok && data.team) {
          return { ok: true, display: data.team };
        }
        return { ok: false, error: data.error ?? 'Invalid token' };
      }
      case 'matrix': {
        const token = getPlain('token');
        const homeserver = getPlain('homeserver');
        if (!token || !homeserver) return null;
        const url = `${homeserver.replace(/\/$/, '')}/_matrix/client/r0/account/whoami`;
        const res = await fetchWithTimeout(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as { user_id?: string; errcode?: string };
        if (data.user_id) {
          return { ok: true, display: data.user_id };
        }
        return { ok: false, error: data.errcode ?? 'Invalid token' };
      }
      case 'feishu': {
        const appId = getPlain('appId');
        const appSecret = getPlain('appSecret');
        if (!appId || !appSecret) return null;
        const res = await fetchWithTimeout(
          'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
          },
        );
        const data = await res.json() as { code?: number; msg?: string; tenant_access_token?: string };
        if (data.code === 0 && data.tenant_access_token) {
          return { ok: true, display: 'credentials verified' };
        }
        return { ok: false, error: data.msg ?? 'Invalid credentials' };
      }
      default:
        return null;
    }
  } catch {
    return { ok: false, error: 'Connection failed (timeout or network error)' };
  }
}

async function resolveTelegramUsername(token: string, username: string): Promise<string | null> {
  const bare = username.startsWith('@') ? username.slice(1) : username;
  const atName = `@${bare}`;

  // Try getChat first (works if bot has interacted with the user before)
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(atName)}`,
      {},
    );
    const data = await res.json() as { ok: boolean; result?: { id?: number } };
    if (data.ok && data.result?.id) {
      return String(data.result.id);
    }
  } catch {
    // Fall through to getUpdates
  }

  // Fallback: search recent updates for a matching username
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/getUpdates?limit=100`,
      {},
    );
    const data = await res.json() as {
      ok: boolean;
      result?: Array<{ message?: { from?: { id: number; username?: string } } }>;
    };
    if (data.ok && data.result) {
      for (const update of data.result) {
        const from = update.message?.from;
        if (from?.username?.toLowerCase() === bare.toLowerCase()) {
          return String(from.id);
        }
      }
    }
  } catch {
    // Give up
  }

  return null;
}

export async function channelsStep(): Promise<ChannelsResult> {
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
    return { channels: [], dmPolicy: 'pairing' };
  }

  // Ask about DM policy before channel-specific config
  const dmPolicy = guardCancel(
    await clack.select({
      message: 'How should the bot handle messages from unknown users?',
      options: [
        { value: 'pairing', label: 'Pairing (recommended)', hint: 'Unknown users get a code, you approve via CLI' },
        { value: 'open', label: 'Open', hint: 'Anyone can message the bot' },
      ],
    }),
  ) as 'pairing' | 'open';

  const setups: ChannelSetup[] = [];

  for (const channelId of selected) {
    const def = CHANNEL_DEFS.find((d) => d.id === channelId)!;

    // WhatsApp requires git (baileys has a git-hosted dependency)
    if (channelId === 'whatsapp') {
      const gitReady = await ensureGitForWhatsApp();
      if (!gitReady) continue;
    }

    // Show setup guide before asking for credentials
    const guide = SETUP_GUIDES[channelId];
    if (guide) {
      clack.note(guide, `${def.label} Setup`);
    }

    // Show Slack manifest
    if (channelId === 'slack') {
      const manifest = buildSlackManifest();
      clack.note(JSON.stringify(manifest, null, 2), 'Slack App Manifest');
    }

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

    // Validate token
    const spinner = clack.spinner();
    spinner.start('Validating credentials...');
    const validation = await validateToken(channelId, credentials);
    spinner.stop(
      validation === null
        ? 'Validation skipped (env var reference)'
        : validation.ok
          ? `Verified: ${validation.display}`
          : `Warning: ${validation.error} (continuing anyway)`,
    );

    // Install wechaty if WeChat was selected
    if (channelId === 'wechat') {
      clack.log.info('Installing wechaty packages (required for WeChat)...');
      try {
        execSync('npm install -g wechaty wechaty-puppet-wechat4u', { stdio: 'pipe', timeout: 300_000 });
        clack.log.success('wechaty installed.');
      } catch {
        clack.log.warn('Failed to install wechaty. Install manually:\n  npm install -g wechaty wechaty-puppet-wechat4u');
      }
    }

    let channelIds: string[] | undefined;
    if (channelId === 'discord') {
      const useChannelIds = guardCancel(
        await clack.confirm({
          message: 'Allow replies in specific Discord channels without requiring an @mention?',
          initialValue: true,
        }),
      );

      if (useChannelIds) {
        clack.log.info('Tip: enable Discord Developer Mode, then right-click a channel and choose "Copy Channel ID".');
        const raw = guardCancel(
          await clack.text({
            message: 'Enter comma-separated Discord channel IDs',
            placeholder: '123456789012345678, 987654321098765432',
            validate: (v) => (v.trim().length > 0 ? undefined : 'Enter at least one channel ID'),
          }),
        ) as string;

        channelIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }

    // Allowlist prompt
    let allowFrom: string[] | undefined;
    const allowlistHint = dmPolicy === 'pairing'
      ? 'Pre-approve specific user IDs? (they skip pairing)'
      : 'Restrict who can message the bot? (recommended)';
    const wantAllowlist = guardCancel(
      await clack.confirm({
        message: allowlistHint,
        initialValue: false,
      }),
    );

    if (wantAllowlist) {
      const raw = guardCancel(
        await clack.text({
          message: 'Enter comma-separated user IDs or usernames',
          placeholder: 'user1, user2, @username',
          validate: (v) => (v.trim().length > 0 ? undefined : 'Enter at least one user'),
        }),
      ) as string;

      allowFrom = raw.split(',').map((s) => s.trim()).filter(Boolean);

      // Offer to resolve Telegram usernames to numeric IDs
      if (channelId === 'telegram') {
        const token = typeof credentials.token === 'string' ? credentials.token : null;
        if (token && allowFrom.some((u) => u.startsWith('@') || /^[a-zA-Z]/.test(u))) {
          const resolve = guardCancel(
            await clack.confirm({
              message: 'Resolve @usernames to numeric IDs via Telegram API?',
              initialValue: true,
            }),
          );
          if (resolve) {
            const resolved: string[] = [];
            for (const entry of allowFrom) {
              if (entry.startsWith('@') || /^[a-zA-Z]/.test(entry)) {
                let numericId = await resolveTelegramUsername(token, entry);
                if (!numericId) {
                  clack.log.warn(
                    `Could not resolve ${entry} — the user must message the bot first.`,
                  );
                  const retry = guardCancel(
                    await clack.confirm({
                      message: `Have ${entry} send any message to the bot, then confirm to retry`,
                      initialValue: true,
                    }),
                  );
                  if (retry) {
                    numericId = await resolveTelegramUsername(token, entry);
                  }
                }
                if (numericId) {
                  clack.log.info(`${entry} → ${numericId}`);
                  resolved.push(numericId);
                } else {
                  clack.log.warn(`Still could not resolve ${entry}, keeping as-is`);
                  resolved.push(entry);
                }
              } else {
                resolved.push(entry);
              }
            }
            allowFrom = resolved;
          }
        }
      }
    }

    setups.push({
      id: channelId,
      credentials,
      ...(allowFrom && allowFrom.length > 0 ? { allowFrom } : {}),
      ...(channelIds && channelIds.length > 0 ? { channelIds } : {}),
    });
  }

  return { channels: setups, dmPolicy };
}
