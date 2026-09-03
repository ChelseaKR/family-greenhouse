import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLANT_ID_CREDITS_PER_IDENTIFICATION,
  PLANT_ID_EUR_PER_CREDIT_LIST,
  PLANT_ID_USD_PER_CREDIT,
  PLANT_ID_USD_PER_CREDIT_DEFAULT,
  PLANT_ID_USD_PER_EUR_ASSUMED,
  parseUsdPerUnit,
} from '../../../src/config/upstreamCosts.js';

describe('upstream cost constants (cost accounting, never gating)', () => {
  afterEach(() => {
    delete process.env.PLANT_ID_USD_PER_CREDIT;
    vi.resetModules();
  });

  it('holds the USD default to the recorded EUR list price times the assumed rate', () => {
    // The default is a literal so logged costUsd values are clean. This is
    // the tie that stops someone updating the tier or the FX rate without
    // updating the number that is actually accounted.
    expect(PLANT_ID_EUR_PER_CREDIT_LIST * PLANT_ID_USD_PER_EUR_ASSUMED).toBeCloseTo(
      PLANT_ID_USD_PER_CREDIT_DEFAULT,
      10
    );
    expect(PLANT_ID_USD_PER_CREDIT_DEFAULT).toBe(0.0585);
    expect(PLANT_ID_CREDITS_PER_IDENTIFICATION).toBe(1);
  });

  it('uses the default when no override is set in this process', () => {
    expect(process.env.PLANT_ID_USD_PER_CREDIT).toBeUndefined();
    expect(PLANT_ID_USD_PER_CREDIT).toBe(PLANT_ID_USD_PER_CREDIT_DEFAULT);
  });

  it('honours a valid env override at module load', async () => {
    process.env.PLANT_ID_USD_PER_CREDIT = '0.0351';
    vi.resetModules();
    const fresh = await import('../../../src/config/upstreamCosts.js');
    expect(fresh.PLANT_ID_USD_PER_CREDIT).toBe(0.0351);
  });

  it.each([undefined, '', '   ', 'abc', 'NaN', '-0.01', 'Infinity'])(
    'falls back to the default for an unusable override: %j',
    (raw) => {
      expect(parseUsdPerUnit(raw, 0.0585)).toBe(0.0585);
    }
  );

  it.each([
    ['0', 0],
    ['0.02', 0.02],
    [' 0.0585 ', 0.0585],
    ['1', 1],
  ])('parses a usable override %j as %d', (raw, expected) => {
    expect(parseUsdPerUnit(raw, 99)).toBe(expected);
  });
});
