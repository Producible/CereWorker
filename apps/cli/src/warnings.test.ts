import { describe, expect, it } from 'vitest';
import { shouldSuppressWarning } from './warnings.js';

describe('shouldSuppressWarning', () => {
  it('suppresses the node:sqlite experimental warning', () => {
    expect(shouldSuppressWarning([
      'SQLite is an experimental feature and might change at any time',
      'ExperimentalWarning',
    ])).toBe(true);
  });

  it('suppresses the transitive punycode deprecation warning', () => {
    expect(shouldSuppressWarning([
      'The punycode module is deprecated.',
      'DeprecationWarning',
    ])).toBe(true);
  });

  it('does not suppress unrelated warnings', () => {
    expect(shouldSuppressWarning([
      'Something else happened',
      'ExperimentalWarning',
    ])).toBe(false);
  });
});
