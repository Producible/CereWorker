import { describe, it, expect } from 'vitest';
import { getChannelInstructions } from './summary.js';

describe('getChannelInstructions', () => {
  it('returns Telegram instructions mentioning polling', () => {
    const result = getChannelInstructions('telegram');
    expect(result).toContain('polling automatically');
    expect(result).not.toContain('webhook');
  });

  it('returns Discord instructions with OAuth2 invite', () => {
    expect(getChannelInstructions('discord')).toContain('OAuth2 URL');
  });

  it('returns Slack instructions mentioning Socket Mode', () => {
    const result = getChannelInstructions('slack');
    expect(result).toContain('Socket Mode');
    expect(result).toContain('no webhook');
  });

  it('returns Matrix instructions about room invite', () => {
    expect(getChannelInstructions('matrix')).toContain('Invite the bot');
  });

  it('returns Feishu instructions mentioning admin console', () => {
    expect(getChannelInstructions('feishu')).toContain('admin console');
  });

  it('returns WeChat instructions with QR code', () => {
    expect(getChannelInstructions('wechat')).toContain('QR code');
  });

  it('returns fallback for unknown channel', () => {
    expect(getChannelInstructions('unknown')).toContain('See documentation');
  });

  it('includes channel id in fallback message', () => {
    expect(getChannelInstructions('line')).toContain('line');
  });
});
