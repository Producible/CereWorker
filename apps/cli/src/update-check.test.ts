import { describe, expect, it } from 'vitest';
import { isNewer } from './update-check.js';

describe('isNewer', () => {
  it('detects newer major version', () => {
    expect(isNewer('27.101.1', '26.329.10')).toBe(true);
  });

  it('detects newer minor (date) version', () => {
    expect(isNewer('26.330.1', '26.329.10')).toBe(true);
  });

  it('detects newer patch version', () => {
    expect(isNewer('26.329.11', '26.329.10')).toBe(true);
  });

  it('returns false for same version', () => {
    expect(isNewer('26.329.10', '26.329.10')).toBe(false);
  });

  it('returns false for older version', () => {
    expect(isNewer('26.329.9', '26.329.10')).toBe(false);
    expect(isNewer('26.328.1', '26.329.10')).toBe(false);
    expect(isNewer('25.101.1', '26.329.10')).toBe(false);
  });

  it('handles CalVer format correctly (YY.MMDD.counter)', () => {
    // March 29 → March 30
    expect(isNewer('26.330.1', '26.329.5')).toBe(true);
    // Same day, higher counter
    expect(isNewer('26.329.6', '26.329.5')).toBe(true);
    // Older day
    expect(isNewer('26.328.99', '26.329.1')).toBe(false);
  });
});
