import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecSync, mockSpawnSync, mockConfirm, mockLog } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockSpawnSync: vi.fn(() => ({ status: 1 })),
  mockConfirm: vi.fn(),
  mockLog: { warn: vi.fn(), info: vi.fn(), step: vi.fn(), success: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

vi.mock('../prompter.js', () => ({
  clack: {
    confirm: mockConfirm,
    log: mockLog,
  },
  guardCancel: <T>(v: T) => v,
}));

import { hasGit, ensureGitForWhatsApp } from './channels.js';

describe('hasGit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when git is available', () => {
    mockExecSync.mockReturnValue(Buffer.from('git version 2.43.0'));
    expect(hasGit()).toBe(true);
  });

  it('returns false when git is not available', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: git');
    });
    expect(hasGit()).toBe(false);
  });
});

describe('ensureGitForWhatsApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true immediately when git is available', async () => {
    mockExecSync.mockReturnValue(Buffer.from('git version 2.43.0'));
    const result = await ensureGitForWhatsApp();
    expect(result).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('returns false when git is missing and user declines install', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: git');
    });
    mockConfirm.mockResolvedValue(false);

    const result = await ensureGitForWhatsApp();

    expect(result).toBe(false);
    expect(mockLog.warn).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping WhatsApp'),
    );
  });

  it('returns false when auto-install is unavailable and git still missing', async () => {
    // No package manager found (spawnSync returns status 1 for all)
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: git');
    });
    mockConfirm.mockResolvedValue(true);

    const result = await ensureGitForWhatsApp();

    expect(result).toBe(false);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping WhatsApp'),
    );
  });

  it('returns true when auto-install succeeds', async () => {
    let callCount = 0;
    mockExecSync.mockImplementation(() => {
      callCount++;
      // 1st: hasGit() at top — no git
      if (callCount === 1) throw new Error('command not found: git');
      // 2nd: the apt-get install command — succeeds
      if (callCount === 2) return Buffer.from('');
      // 3rd: hasGit() re-check after install — git now available
      return Buffer.from('git version 2.43.0');
    });
    // Simulate apt-get being available
    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => ({
      status: args?.[0] === 'apt-get' ? 0 : 1,
    }));
    mockConfirm.mockResolvedValue(true);

    const result = await ensureGitForWhatsApp();

    expect(result).toBe(true);
    expect(mockLog.success).toHaveBeenCalledWith('git installed.');
  });

  it('returns false when auto-install command fails', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: git');
    });
    // Simulate apt-get being available
    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => ({
      status: args?.[0] === 'apt-get' ? 0 : 1,
    }));
    mockConfirm.mockResolvedValue(true);

    const result = await ensureGitForWhatsApp();

    expect(result).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith('git installation failed.');
  });
});
