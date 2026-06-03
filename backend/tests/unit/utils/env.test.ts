import { afterEach, describe, expect, it } from 'vitest';
import { requireEnv } from '../../../src/utils/env.js';

const ORIGINAL = process.env;

afterEach(() => {
  process.env = ORIGINAL;
});

describe('requireEnv', () => {
  it('returns the value when set', () => {
    process.env = { ...ORIGINAL, FOO: 'bar' };
    expect(requireEnv('FOO')).toBe('bar');
  });

  it('returns a test sentinel when unset under NODE_ENV=test', () => {
    process.env = { ...ORIGINAL, NODE_ENV: 'test' };
    delete process.env.MISSING_VAR;
    expect(requireEnv('MISSING_VAR')).toBe('__test_MISSING_VAR__');
  });

  it('throws when unset outside test env', () => {
    process.env = { ...ORIGINAL, NODE_ENV: 'production' };
    delete process.env.OTHER_MISSING;
    expect(() => requireEnv('OTHER_MISSING')).toThrow(/OTHER_MISSING/);
  });

  it('throws on empty string', () => {
    process.env = { ...ORIGINAL, NODE_ENV: 'production', EMPTY: '' };
    expect(() => requireEnv('EMPTY')).toThrow(/EMPTY/);
  });
});
