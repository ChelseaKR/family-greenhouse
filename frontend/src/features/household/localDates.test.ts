import { describe, expect, it } from 'vitest';
import { toEndOfDayIso, toStartOfDayIso, todayLocalDateValue } from './localDates';

// vitest.config.ts pins TZ to America/New_York, so a picked day starts at
// 04:00Z in summer — not 00:00Z. That difference is the whole point of these
// helpers: a UTC-anchored reading would open a sitter's access four hours
// early and close it four hours early too.
describe('local day boundaries', () => {
  it('anchors the start of a picked day to local midnight', () => {
    expect(toStartOfDayIso('2026-06-15')).toBe('2026-06-15T04:00:00.000Z');
  });

  it('anchors the end of a picked day to the last local instant', () => {
    expect(toEndOfDayIso('2026-06-15')).toBe('2026-06-16T03:59:59.999Z');
  });

  it('reads a winter day in the same zone, one hour later in UTC', () => {
    expect(toStartOfDayIso('2026-01-15')).toBe('2026-01-15T05:00:00.000Z');
  });

  it('formats today for a date input in local time, not UTC', () => {
    // 00:30 local on the 15th is already the 16th in UTC; a `min` built from
    // the UTC date would refuse the day the user is actually living in.
    expect(todayLocalDateValue(new Date(2026, 5, 15, 0, 30))).toBe('2026-06-15');
  });
});
