import { describe, expect, it } from 'vitest';
import { CARE_GUIDES } from '@/features/care/careGuides';
import {
  LAST_WATERED_BUCKETS,
  STATED_INTERVALS,
  formatCheckDay,
  isLastWateredBucket,
  nextCheck,
  statedInterval,
} from '@/features/care/nextWatering';

/**
 * Words in a water line that state a calendar interval. "once dry" is a
 * soil rule, not a count, so only "once a ..." counts.
 */
const STATES_A_COUNT =
  /\b(?:\d+|one|two|three|four)\s+(?:days?|weeks?)\b|\bweekly\b|\bmonthly\b|\bdaily\b|\bonce a (?:day|week|month)\b|\btwice a\b|\bevery\b/iu;

describe('STATED_INTERVALS', () => {
  it('counts only from words the guide itself prints in its water line', () => {
    for (const [slug, interval] of Object.entries(STATED_INTERVALS)) {
      const guide = CARE_GUIDES.find((g) => g.slug === slug);
      expect(guide, slug).toBeDefined();
      expect(guide!.quickFacts.water, slug).toContain(interval.stated);
      expect(STATES_A_COUNT.test(interval.stated), slug).toBe(true);
      expect(Number.isInteger(interval.days) && interval.days >= 1, slug).toBe(true);
    }
  });

  it('gives a date for every guide whose water line states a count, and no other', () => {
    const counted = CARE_GUIDES.filter((g) => STATES_A_COUNT.test(g.quickFacts.water)).map(
      (g) => g.slug
    );
    expect(Object.keys(STATED_INTERVALS).sort()).toEqual(counted.sort());
    // Most guides give a soil rule, not a calendar: they get no date.
    const uncounted = CARE_GUIDES.filter((g) => !counted.includes(g.slug));
    expect(uncounted.length).toBeGreaterThan(0);
    for (const guide of uncounted) expect(statedInterval(guide.slug), guide.slug).toBeUndefined();
  });

  it('negative control: a guide that stops printing its count fails the check', () => {
    const zz = CARE_GUIDES.find((g) => g.slug === 'zz-plant')!;
    const edited = zz.quickFacts.water.replace('About every 2 weeks in summer', 'When dry');
    expect(edited).not.toBe(zz.quickFacts.water);
    expect(edited.includes(STATED_INTERVALS['zz-plant']!.stated)).toBe(false);
  });

  it('never reads a prototype key as a guide', () => {
    expect(statedInterval('constructor')).toBeUndefined();
    expect(statedInterval('__proto__')).toBeUndefined();
  });
});

describe('nextCheck', () => {
  // Noon, local time, on 2026-12-02.
  const now = new Date(2026, 11, 2, 12, 0, 0);

  it('counts from the last watering', () => {
    expect(nextCheck(14, 'today', now)).toEqual({
      today: false,
      date: { year: 2026, month: 12, day: 16 },
    });
    expect(nextCheck(14, 'week', now)).toEqual({
      today: false,
      date: { year: 2026, month: 12, day: 9 },
    });
    expect(nextCheck(7, 'today', new Date(2026, 11, 28, 9))).toEqual({
      today: false,
      date: { year: 2027, month: 1, day: 4 },
    });
  });

  it('says today when the check is already due', () => {
    expect(nextCheck(14, 'two_weeks', now)).toEqual({
      today: true,
      date: { year: 2026, month: 12, day: 2 },
    });
    expect(nextCheck(7, 'week', now).today).toBe(true);
    expect(nextCheck(3, 'week', now).today).toBe(true);
  });

  it('never computes a date for "Not sure"', () => {
    for (const days of [3, 7, 14]) {
      expect(nextCheck(days, 'unsure', now)).toEqual({
        today: true,
        date: { year: 2026, month: 12, day: 2 },
      });
    }
  });

  it('formats the day in words', () => {
    expect(formatCheckDay({ year: 2026, month: 12, day: 16 })).toBe('Wednesday, December 16');
  });

  it('accepts only its own answers', () => {
    for (const bucket of LAST_WATERED_BUCKETS) expect(isLastWateredBucket(bucket)).toBe(true);
    for (const value of ['', 'yesterday', 'TODAY', null, undefined, 7]) {
      expect(isLastWateredBucket(value), String(value)).toBe(false);
    }
  });
});
