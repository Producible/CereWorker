import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the loader to redirect GLOBAL_CONFIG to a temp path
const dir = mkdtempSync(join(tmpdir(), 'cereworker-writer-test-'));
const tempConfigPath = join(dir, 'config.yaml');

vi.mock('./loader.js', () => ({
  ensureConfigDir: vi.fn(),
  GLOBAL_CONFIG: tempConfigPath,
}));

// Import after mock is set up
const { writeConfig } = await import('./writer.js');

describe('writeConfig', () => {
  afterEach(() => {
    // Clean up generated files
    const tmpFile = tempConfigPath + '.tmp';
    if (existsSync(tmpFile)) rmSync(tmpFile);
    if (existsSync(tempConfigPath)) rmSync(tempConfigPath);
  });

  it('writes valid YAML at configured path', () => {
    writeConfig({ name: 'test' });
    expect(existsSync(tempConfigPath)).toBe(true);
    const content = readFileSync(tempConfigPath, 'utf-8');
    expect(content).toContain('name: test');
  });

  it('serializes nested objects correctly', () => {
    writeConfig({
      cerebrum: { defaultProvider: 'openai', maxSteps: 20 },
    });
    const content = readFileSync(tempConfigPath, 'utf-8');
    expect(content).toContain('cerebrum');
    expect(content).toContain('defaultProvider: openai');
    expect(content).toContain('maxSteps: 20');
  });

  it('calls ensureConfigDir', async () => {
    const { ensureConfigDir } = await import('./loader.js');
    writeConfig({ a: 1 });
    expect(ensureConfigDir).toHaveBeenCalled();
  });

  it('handles empty config', () => {
    writeConfig({});
    expect(existsSync(tempConfigPath)).toBe(true);
    const content = readFileSync(tempConfigPath, 'utf-8');
    expect(content).toMatch(/^\{?\}?\s*$/);
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
