import type { CereWorkerConfig } from '@cereworker/config';
import { ChannelManager } from './manager.js';
import { createSlackChannel } from './adapters/slack.js';
import { createDiscordChannel } from './adapters/discord.js';
import { createTelegramChannel } from './adapters/telegram.js';
import { createMatrixChannel } from './adapters/matrix.js';
import { createFeishuChannel } from './adapters/feishu.js';
import { createWeChatChannel } from './adapters/wechat.js';

export function createChannelManager(config: CereWorkerConfig): ChannelManager {
  const manager = new ChannelManager();

  const { channels } = config;

  if (channels.slack.enabled && channels.slack.botToken && channels.slack.appToken) {
    manager.register(
      createSlackChannel({
        botToken: channels.slack.botToken,
        appToken: channels.slack.appToken,
        signingSecret: channels.slack.signingSecret,
        allowFrom: channels.slack.allowFrom,
      }),
    );
  }

  if (channels.discord.enabled && channels.discord.token) {
    manager.register(
      createDiscordChannel({
        token: channels.discord.token,
        applicationId: channels.discord.applicationId,
        allowFrom: channels.discord.allowFrom,
        channelIds: channels.discord.channelIds,
      }),
    );
  }

  if (channels.telegram.enabled && channels.telegram.token) {
    manager.register(
      createTelegramChannel({
        token: channels.telegram.token,
        allowFrom: channels.telegram.allowFrom,
      }),
    );
  }

  if (channels.matrix.enabled && channels.matrix.token && channels.matrix.userId) {
    manager.register(
      createMatrixChannel({
        homeserver: channels.matrix.homeserver,
        token: channels.matrix.token,
        userId: channels.matrix.userId,
        allowFrom: channels.matrix.allowFrom,
      }),
    );
  }

  if (channels.feishu.enabled && channels.feishu.appId && channels.feishu.appSecret) {
    manager.register(
      createFeishuChannel({
        appId: channels.feishu.appId,
        appSecret: channels.feishu.appSecret,
        verificationToken: channels.feishu.verificationToken,
        encryptKey: channels.feishu.encryptKey,
        allowFrom: channels.feishu.allowFrom,
      }),
    );
  }

  if (channels.wechat.enabled) {
    manager.register(
      createWeChatChannel({
        puppet: channels.wechat.puppet,
        token: channels.wechat.token,
        allowFrom: channels.wechat.allowFrom,
      }),
    );
  }

  return manager;
}
