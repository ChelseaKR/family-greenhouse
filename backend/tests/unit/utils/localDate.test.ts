import { describe, it, expect } from 'vitest';
import { localDateKey, calendarDaysBetween } from '../../../src/utils/localDate.js';

describe('localDateKey', () => {
  it('returns the calendar date in the given zone', () => {
    // 23:00Z on Jun 9 is still Jun 9 in UTC and already Jun 10 in Sydney.
    const d = new Date('2026-06-09T23:00:00.000Z');
    expect(localDateKey(d, 'UTC')).toBe('2026-06-09');
    expect(localDateKey(d, 'Australia/Sydney')).toBe('2026-06-10');
    expect(localDateKey(d, 'America/New_York')).toBe('2026-06-09');
  });

  it('rolls back a day west of UTC just after UTC midnight', () => {
    const d = new Date('2026-06-10T02:00:00.000Z');
    expect(localDateKey(d, 'UTC')).toBe('2026-06-10');
    expect(localDateKey(d, 'America/New_York')).toBe('2026-06-09');
  });

  it('degrades to UTC on an unrecognized zone rather than throwing', () => {
    const d = new Date('2026-06-09T23:00:00.000Z');
    expect(() => localDateKey(d, 'Not/AZone')).not.toThrow();
    expect(localDateKey(d, 'Not/AZone')).toBe('2026-06-09');
  });

  it('defaults to UTC', () => {
    expect(localDateKey(new Date('2026-06-09T23:00:00.000Z'))).toBe('2026-06-09');
  });
});

describe('calendarDaysBetween', () => {
  it('counts a calendar-day boundary crossed in under 24 hours', () => {
    // Thirteen hours apart, but two different calendar days. This is the
    // case `floor(elapsed / 24h)` scored 0 and the task list called 1 day
    // overdue (#342 item 4).
    const from = new Date('2026-06-10T23:00:00.000Z');
    const to = new Date('2026-06-11T12:00:00.000Z');
    expect(calendarDaysBetween(from, to, 'UTC')).toBe(1);
  });

  it('returns 0 within one calendar day even across many hours', () => {
    const from = new Date('2026-06-11T00:30:00.000Z');
    const to = new Date('2026-06-11T23:30:00.000Z');
    expect(calendarDaysBetween(from, to, 'UTC')).toBe(0);
  });

  it('is negative when `to` precedes `from`', () => {
    const from = new Date('2026-06-11T12:00:00.000Z');
    const to = new Date('2026-06-10T12:00:00.000Z');
    expect(calendarDaysBetween(from, to, 'UTC')).toBe(-1);
  });

  it('counts one day across spring-forward, when only 23 hours elapse', () => {
    // America/New_York springs forward 2026-03-08. Local midnight Mar 8 to
    // local midnight Mar 9 is 23 real hours; it is still one calendar day.
    const from = new Date('2026-03-08T05:00:00.000Z'); // Mar 8 00:00 EST
    const to = new Date('2026-03-09T04:00:00.000Z'); // Mar 9 00:00 EDT
    expect(calendarDaysBetween(from, to, 'America/New_York')).toBe(1);
    // The naive 24h division would have said 0.
    expect(Math.floor((to.getTime() - from.getTime()) / 86_400_000)).toBe(0);
  });

  it('counts one day across fall-back, when 25 hours elapse', () => {
    // America/New_York falls back 2026-11-01.
    const from = new Date('2026-11-01T04:00:00.000Z'); // Nov 1 00:00 EDT
    const to = new Date('2026-11-02T05:00:00.000Z'); // Nov 2 00:00 EST
    expect(calendarDaysBetween(from, to, 'America/New_York')).toBe(1);
    // The naive 24h division would have said 1 here too, but for the wrong
    // reason — it is measuring elapsed time, not days.
    expect(Math.floor((to.getTime() - from.getTime()) / 86_400_000)).toBe(1);
  });

  it('counts leap day as an ordinary day', () => {
    // No leap-day fixture existed anywhere in this repo before 2026-08-28.
    const from = new Date('2028-02-28T12:00:00.000Z');
    const to = new Date('2028-02-29T12:00:00.000Z');
    expect(calendarDaysBetween(from, to, 'UTC')).toBe(1);
    expect(calendarDaysBetween(from, new Date('2028-03-01T12:00:00.000Z'), 'UTC')).toBe(2);
  });
});
