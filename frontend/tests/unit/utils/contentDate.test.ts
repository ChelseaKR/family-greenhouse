import { describe, expect, it } from 'vitest';
import { formatContentDate } from '@/utils/contentDate';

/**
 * vitest.config.ts pins TZ to America/New_York, so every assertion here is
 * live: the naive `new Date(iso).toLocaleDateString()` these replace prints
 * the day before the literal in that zone, and a month-first literal falls
 * into the previous month.
 */
describe('formatContentDate', () => {
  it('prints the day the literal names, not the day before it', () => {
    expect(formatContentDate('2026-09-05')).toBe('September 5, 2026');
  });

  it('keeps a first-of-the-month literal in its own month', () => {
    expect(formatContentDate('2026-09-01', 'month')).toBe('September 2026');
    expect(formatContentDate('2026-09-01', 'short')).toBe('Sep 1');
  });

  it('is unmoved by the day of year', () => {
    // Both sides of a US DST transition, and the year boundary.
    expect(formatContentDate('2026-03-08')).toBe('March 8, 2026');
    expect(formatContentDate('2026-11-01')).toBe('November 1, 2026');
    expect(formatContentDate('2026-01-01', 'month')).toBe('January 2026');
  });

  it('refuses anything that is not a date-only literal', () => {
    expect(() => formatContentDate('2026-09-05T00:00:00Z')).toThrow(/YYYY-MM-DD/);
    expect(() => formatContentDate('September 5, 2026')).toThrow(/YYYY-MM-DD/);
  });
});
