import { describe, it, expect } from 'vitest';
import { getChannelInstructions } from './summary.js';

describe('getChannelInstructions', () => {
  it('returns Telegram instructions with BotFather', () => {
    expect(getChannelInstructions('telegram')).toContain('@BotFather');
  });

  it('returns Discord instructions with developer portal', () => {
    expect(getChannelInstructions('discord')).toContain('discord.com/developers');
  });

  it('returns Slack instructions with app creation URL', () => {
    expect(getChannelInstructions('slack')).toContain('api.slack.com/apps');
  });

  it('returns Matrix instructions with homeserver', () => {
    expect(getChannelInstructions('matrix')).toContain('homeserver');
  });

  it('returns Feishu instructions with open platform', () => {
    const result = getChannelInstructions('feishu');
    expect(result).toContain('Open platform');
    expect(result).toContain('App ID/Secret');
  });

  it('returns WeChat instructions with registration URL', () => {
    expect(getChannelInstructions('wechat')).toContain('mp.weixin.qq.com');
  });

  it('returns fallback for unknown channel', () => {
    expect(getChannelInstructions('unknown')).toContain('See documentation');
  });

  it('includes channel id in fallback message', () => {
    expect(getChannelInstructions('line')).toContain('line');
  });
});
