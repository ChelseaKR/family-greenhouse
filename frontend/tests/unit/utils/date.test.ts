import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dueDayOffset,
  formatDate,
  formatRelativeDate,
  isOverdue,
  isToday,
  overdueAt,
} from '@/utils/date';

describe('date utils', () => {
  beforeEach(() => {
    // Mock current date to 2024-04-15
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-04-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('formatDate', () => {
    it('returns "Never" for null/undefined', () => {
      expect(formatDate(null)).toBe('Never');
      expect(formatDate(undefined)).toBe('Never');
    });

    it('formats date correctly', () => {
      const result = formatDate('2024-04-15T12:00:00Z');
      expect(result).toContain('Apr');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });
  });

  describe('formatRelativeDate', () => {
    it('returns "Today" for today', () => {
      expect(formatRelativeDate('2024-04-15T12:00:00Z')).toBe('Today');
    });

    it('returns "Tomorrow" for tomorrow', () => {
      expect(formatRelativeDate('2024-04-16T12:00:00Z')).toBe('Tomorrow');
    });

    it('returns "Yesterday" for yesterday', () => {
      expect(formatRelativeDate('2024-04-14T12:00:00Z')).toBe('Yesterday');
    });

    it('returns days ago for past dates', () => {
      expect(formatRelativeDate('2024-04-12T12:00:00Z')).toBe('3 days ago');
    });
  });

  describe('isOverdue', () => {
    it('returns true for past dates', () => {
      expect(isOverdue('2024-04-14T12:00:00Z')).toBe(true);
    });

    it('returns false for today', () => {
      expect(isOverdue('2024-04-15T12:00:00Z')).toBe(false);
    });

    it('returns false for future dates', () => {
      expect(isOverdue('2024-04-16T12:00:00Z')).toBe(false);
    });

    it('classifies against an injected clock instead of the ambient one', () => {
      const nextWeek = new Date('2024-04-22T12:00:00Z');
      expect(isOverdue('2024-04-16T12:00:00Z', nextWeek)).toBe(true);
      expect(isOverdue('2024-04-22T12:00:00Z', nextWeek)).toBe(false);
    });
  });

  describe('overdueAt', () => {
    it('is local midnight after the due date’s calendar day', () => {
      const start = new Date('2024-04-15T12:00:00Z');
      start.setHours(0, 0, 0, 0);
      const nextMidnight = new Date(start);
      nextMidnight.setDate(nextMidnight.getDate() + 1);
      expect(overdueAt('2024-04-15T12:00:00Z')).toBe(nextMidnight.getTime());
    });

    it('is the same instant for every time of day on the due date', () => {
      // A recurring task lands at an arbitrary hour (completion advances
      // `nextDue` from the completion instant), and none of them may change
      // when the household starts calling it overdue.
      const morning = overdueAt('2024-04-15T13:00:00Z');
      expect(overdueAt('2024-04-15T04:00:00Z')).toBe(morning);
      expect(overdueAt('2024-04-15T23:00:00Z')).toBe(morning);
    });

    it('is NaN for an unparseable date, so schedulers can drop it', () => {
      expect(overdueAt('not-a-date')).toBeNaN();
      expect(Number.isFinite(overdueAt('not-a-date'))).toBe(false);
    });

    // The coupling the alert path depends on (#591): the instant a scheduler
    // wakes for is exactly the instant the predicate flips. If either helper
    // is changed alone — the household-timezone migration will change both —
    // this fails.
    it('agrees with isOverdue at every hour across a week', () => {
      const base = new Date('2024-04-15T00:00:00Z').getTime();
      const due = '2024-04-15T09:30:00Z';
      const flipsAt = overdueAt(due);
      for (let hour = 0; hour < 24 * 7; hour += 1) {
        const now = new Date(base + hour * 3_600_000);
        expect(isOverdue(due, now)).toBe(flipsAt <= now.getTime());
      }
    });
  });

  describe('isToday', () => {
    it('returns true for today', () => {
      expect(isToday('2024-04-15T12:00:00Z')).toBe(true);
    });

    it('returns false for other dates', () => {
      expect(isToday('2024-04-14T12:00:00Z')).toBe(false);
      expect(isToday('2024-04-16T12:00:00Z')).toBe(false);
    });
  });
});

describe('dueDayOffset', () => {
  it('reads an unparseable due date as unknown, never as today', () => {
    expect(dueDayOffset('not a date', new Date(2026, 9, 14, 14))).toBeNull();
    expect(dueDayOffset('', new Date(2026, 9, 14, 14))).toBeNull();
  });

  it('agrees with isOverdue and isToday at every quarter hour of a day', () => {
    // Due dates around one local day, read from every quarter hour of that
    // day: below zero exactly when isOverdue says so, zero exactly when
    // isToday does. Built from local wall-clock fields, so this holds in
    // whatever zone the process runs in.
    const dues = [
      new Date(2026, 9, 13, 23, 59),
      new Date(2026, 9, 14, 0, 0),
      new Date(2026, 9, 14, 9, 0),
      new Date(2026, 9, 14, 23, 59, 59, 999),
      new Date(2026, 9, 15, 0, 0),
      new Date(2026, 9, 16, 9, 0),
    ].map((d) => d.toISOString());
    vi.useFakeTimers();
    try {
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        const now = new Date(2026, 9, 14, 0, minutes);
        vi.setSystemTime(now);
        for (const due of dues) {
          const days = dueDayOffset(due, now);
          expect(days !== null && days < 0).toBe(isOverdue(due, now));
          expect(days === 0).toBe(isToday(due));
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
