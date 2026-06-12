/**
 * DST regression tests for calendar-day math.
 *
 * The fall-back transition (America/New_York, 2026-11-01) makes the local
 * day 25 hours long. Local-midnight subtraction + Math.ceil therefore
 * reported "2 days ago" for yesterday. The fixed helpers anchor both
 * calendar dates at UTC noon, where every day is exactly 24h.
 *
 * The timezone is pinned to America/New_York in vitest.config.ts (it must
 * be set in the main vitest process — workers see a proxied process.env
 * where TZ assignment never reaches the native tzset). We verify it took
 * effect and skip rather than assert nonsense when a different TZ was
 * explicitly exported. Inputs use fixed UTC offsets (-04:00 EDT / -05:00
 * EST) so the instants themselves are unambiguous.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { calendarDaysBetween, formatRelativeDate } from '@/utils/date';

// EST is UTC-5 → getTimezoneOffset() === 300 in winter. If the TZ override
// didn't take, these assertions would be meaningless; skip instead.
const tzActive = new Date('2026-01-15T12:00:00Z').getTimezoneOffset() === 300;

describe.runIf(tzActive)('DST fall-back (America/New_York, 2026-11-01)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // "Now" = Mon 2026-11-02 12:00 EST (the day after the 25-hour Sunday).
    vi.setSystemTime(new Date('2026-11-02T12:00:00-05:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports Yesterday (not "2 days ago") across the 25-hour day', () => {
    // Sun 2026-11-01 12:00 EST — one calendar day earlier, 25 wall hours.
    expect(formatRelativeDate('2026-11-01T12:00:00-05:00')).toBe('Yesterday');
  });

  it('reports 2 days ago for the day before the transition', () => {
    // Sat 2026-10-31 12:00 EDT (still daylight time).
    expect(formatRelativeDate('2026-10-31T12:00:00-04:00')).toBe('2 days ago');
  });

  it('reports Tomorrow across the spring-forward 23-hour day', () => {
    vi.setSystemTime(new Date('2027-03-13T12:00:00-05:00')); // day before spring forward
    expect(formatRelativeDate('2027-03-14T12:00:00-04:00')).toBe('Tomorrow');
  });

  it('calendarDaysBetween counts the transition day as exactly one day', () => {
    const sun = new Date('2026-11-01T12:00:00-05:00');
    const mon = new Date('2026-11-02T12:00:00-05:00');
    expect(calendarDaysBetween(sun, mon)).toBe(1);
    expect(calendarDaysBetween(mon, sun)).toBe(-1);
  });

  it('calendarDaysBetween is 0 within the same (25-hour) local day', () => {
    const earlyEdt = new Date('2026-11-01T01:30:00-04:00'); // 1:30 AM EDT
    const lateEst = new Date('2026-11-01T23:30:00-05:00'); // 11:30 PM EST
    expect(calendarDaysBetween(earlyEdt, lateEst)).toBe(0);
  });
});

describe('calendarDaysBetween (timezone-independent sanity)', () => {
  it('counts plain consecutive days', () => {
    expect(calendarDaysBetween(new Date(2026, 5, 10, 9), new Date(2026, 5, 11, 9))).toBe(1);
    expect(calendarDaysBetween(new Date(2026, 5, 10, 23), new Date(2026, 5, 11, 1))).toBe(1);
    expect(calendarDaysBetween(new Date(2026, 5, 10), new Date(2026, 5, 10, 23, 59))).toBe(0);
  });

  it('spans month and year boundaries', () => {
    expect(calendarDaysBetween(new Date(2026, 11, 31), new Date(2027, 0, 1))).toBe(1);
    expect(calendarDaysBetween(new Date(2026, 0, 1), new Date(2026, 1, 1))).toBe(31);
  });
});
