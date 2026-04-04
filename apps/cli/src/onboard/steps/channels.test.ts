import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecSync, mockSpawnSync, mockConfirm, mockMultiselect, mockSelect, mockLog, mockNote, mockSpinner } = vi.hoisted(() => ({
  mockExecSync: vi.fn<(cmd: string, opts?: object) => Buffer>(),
  mockSpawnSync: vi.fn<(cmd: string, args?: string[], opts?: object) => { status: number }>(() => ({ status: 1 })),
  mockConfirm: vi.fn(),
  mockMultiselect: vi.fn(),
  mockSelect: vi.fn(),
  mockLog: { warn: vi.fn(), info: vi.fn(), step: vi.fn(), success: vi.fn() },
  mockNote: vi.fn(),
  mockSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  spawnSync: mockSpawnSync,
}));

vi.mock('../prompter.js', () => ({
  clack: {
    confirm: mockConfirm,
    multiselect: mockMultiselect,
    select: mockSelect,
    log: mockLog,
    note: mockNote,
    spinner: mockSpinner,
  },
  guardCancel: <T>(v: T) => v,
}));

import { hasGit, ensureGitForWhatsApp, channelsStep } from './channels.js';

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

  it('returns false without prompting when no auto-install is available', async () => {
    // No git, no package manager (spawnSync returns status 1 for all)
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: git');
    });

    const result = await ensureGitForWhatsApp();

    expect(result).toBe(false);
    // Should not ask "Install git now?" when there's no auto-install command
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping WhatsApp'),
    );
  });

  it('returns false when user declines auto-install', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: git');
    });
    // Simulate apt-get being available so the prompt is shown
    mockSpawnSync.mockImplementation((_cmd: string, args?: string[]) => ({
      status: args?.[0] === 'apt-get' ? 0 : 1,
    }));
    mockConfirm.mockResolvedValue(false);

    const result = await ensureGitForWhatsApp();

    expect(result).toBe(false);
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping WhatsApp'),
    );
  });

  it('returns true when auto-install succeeds', async () => {
    let callCount = 0;
    mockExecSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('command not found: git');
      if (callCount === 2) return Buffer.from('');
      return Buffer.from('git version 2.43.0');
    });
    mockSpawnSync.mockImplementation((_cmd: string, args?: string[]) => ({
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
    mockSpawnSync.mockImplementation((_cmd: string, args?: string[]) => ({
      status: args?.[0] === 'apt-get' ? 0 : 1,
    }));
    mockConfirm.mockResolvedValue(true);

    const result = await ensureGitForWhatsApp();

    expect(result).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith('git installation failed.');
  });
});

describe('channelsStep — WhatsApp/git end-to-end', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes WhatsApp from returned channels when git is missing', async () => {
    // User selects only WhatsApp
    mockMultiselect.mockResolvedValue(['whatsapp']);
    // DM policy prompt
    mockSelect.mockResolvedValue('pairing');
    // git is not available, no package manager
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: git');
    });

    const result = await channelsStep();

    expect(result.channels).toEqual([]);
    expect(result.dmPolicy).toBe('pairing');
  });

  it('includes WhatsApp in returned channels when git is available', async () => {
    // User selects only WhatsApp
    mockMultiselect.mockResolvedValue(['whatsapp']);
    mockSelect.mockResolvedValue('pairing');
    // git is available
    mockExecSync.mockReturnValue(Buffer.from('git version 2.43.0'));
    // No allowlist
    mockConfirm.mockResolvedValue(false);

    const result = await channelsStep();

    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].id).toBe('whatsapp');
  });
});
