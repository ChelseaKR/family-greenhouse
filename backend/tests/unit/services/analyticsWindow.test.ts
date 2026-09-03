import { describe, it, expect } from 'vitest';
import { analyticsWindow } from '../../../src/services/analyticsWindow.js';

describe('analyticsWindow (ADR 0014: the free tier renders a trailing window)', () => {
  const now = new Date('2026-09-03T15:00:00.000Z');

  it('intersects the current year with the trailing N days', () => {
    const w = analyticsWindow(2026, 30, now);
    expect(w.end).toBe(now.toISOString());
    const start = new Date(w.start);
    // 30 days including today → 29 days back, at local midnight.
    const expected = new Date(now);
    expected.setDate(expected.getDate() - 29);
    expected.setHours(0, 0, 0, 0);
    expect(start.toISOString()).toBe(expected.toISOString());
  });

  it('is empty for a past year that ended before the window began', () => {
    const w = analyticsWindow(2025, 30, now);
    expect(w.start).toBe(w.end);
  });

  it('is clipped to the year when the window straddles New Year', () => {
    const jan = new Date('2026-01-10T12:00:00.000Z');
    const w = analyticsWindow(2026, 30, jan);
    expect(w.start).toBe('2026-01-01T00:00:00.000Z');
    expect(w.end).toBe(jan.toISOString());
    const prev = analyticsWindow(2025, 30, jan);
    expect(prev.end).toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(prev.start).getTime()).toBeLessThan(new Date(prev.end).getTime());
  });

  it('never reaches into the future', () => {
    const w = analyticsWindow(2027, 30, now);
    expect(w.start).toBe(w.end);
  });
});
