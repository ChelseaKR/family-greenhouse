import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOUBLE_CARE_WINDOW_HOURS,
  DRIFT_MIN_COMPLETIONS,
  computeScheduleDrift,
  doubleCareWindowHours,
  doubleCareWindowStart,
  nextDueAfterMatch,
  pickRecentDuplicate,
  scheduleDriftUnavailable,
} from '../../../src/services/doubleCareRules.js';

const NOW = new Date('2026-09-03T12:00:00.000Z');

function completion(
  overrides: Partial<{
    id: string;
    taskId: string;
    taskType: string;
    completedBy: string;
    completedByName: string;
    completedAt: string;
    duplicateOfCompletionId: string | null;
  }> = {}
) {
  return {
    id: 'c-1',
    taskId: 't-1',
    taskType: 'water',
    completedBy: 'user-sam',
    completedByName: 'Sam',
    completedAt: '2026-09-03T08:00:00.000Z', // 4h before NOW
    duplicateOfCompletionId: null,
    ...overrides,
  };
}

describe('double-care windows', () => {
  it('defaults watering to 24h and unknown/custom types to the default', () => {
    expect(doubleCareWindowHours('water')).toBe(24);
    expect(doubleCareWindowHours('fertilize')).toBe(72);
    expect(doubleCareWindowHours('Misting')).toBe(DEFAULT_DOUBLE_CARE_WINDOW_HOURS);
  });

  it('opens the window exactly windowHours before now', () => {
    expect(doubleCareWindowStart('water', NOW)).toBe('2026-09-02T12:00:00.000Z');
    expect(doubleCareWindowStart('fertilize', NOW)).toBe('2026-08-31T12:00:00.000Z');
  });
});

describe('pickRecentDuplicate', () => {
  const target = { taskId: 't-1', taskType: 'water', actorId: 'user-me', now: NOW };

  it('flags the same task completed by another member inside the window', () => {
    const dup = pickRecentDuplicate([completion()], target);
    expect(dup).toMatchObject({
      completionId: 'c-1',
      completedByName: 'Sam',
      sameTask: true,
      windowHours: 24,
    });
  });

  it('flags the same plant + care type through a different task (sameTask=false)', () => {
    const dup = pickRecentDuplicate([completion({ taskId: 't-other' })], target);
    expect(dup?.sameTask).toBe(false);
  });

  it('ignores the acting member themself (that is the occurrence token’s job)', () => {
    expect(pickRecentDuplicate([completion({ completedBy: 'user-me' })], target)).toBeNull();
  });

  it('ignores completions outside the window', () => {
    expect(
      pickRecentDuplicate([completion({ completedAt: '2026-09-02T11:59:59.000Z' })], target)
    ).toBeNull();
  });

  it('ignores a different care type on a different task', () => {
    expect(
      pickRecentDuplicate([completion({ taskId: 't-other', taskType: 'prune' })], target)
    ).toBeNull();
  });

  it('picks the most recent match regardless of input order', () => {
    const dup = pickRecentDuplicate(
      [
        completion({ id: 'newer', completedAt: '2026-09-03T11:00:00.000Z' }),
        completion({ id: 'older', completedAt: '2026-09-03T02:00:00.000Z' }),
        completion({ id: 'middle', completedAt: '2026-09-03T06:00:00.000Z' }),
      ].reverse(),
      target
    );
    expect(dup?.completionId).toBe('newer');
  });

  it('skips rows with an unparseable timestamp instead of matching them', () => {
    expect(pickRecentDuplicate([completion({ completedAt: 'not-a-date' })], target)).toBeNull();
  });
});

describe('computeScheduleDrift', () => {
  const at = (day: number, hour = 9) =>
    `2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

  it('reports drift: null with an explicit reason below the minimum, never a 0% drift', () => {
    const reading = computeScheduleDrift(
      't-1',
      7,
      [at(1), at(8), at(15)].map((completedAt) => ({ completedAt }))
    );
    expect(reading).toEqual({
      taskId: 't-1',
      scheduledIntervalDays: 7,
      completionsConsidered: 3,
      requiredCompletions: DRIFT_MIN_COMPLETIONS,
      drift: null,
      reason: 'insufficient_completions',
    });
  });

  it('suggests matching an 11-day rhythm on a 7-day schedule (57% drift)', () => {
    const reading = computeScheduleDrift(
      't-1',
      7,
      [at(1), at(12), at(23), at(3 + 31)].map((completedAt) => ({
        completedAt: completedAt.replace('2026-08-34', '2026-09-03'),
      }))
    );
    expect(reading.completionsConsidered).toBe(4);
    expect(reading.reason).toBeNull();
    expect(reading.drift).toEqual({
      medianIntervalDays: 11,
      driftPct: 0.571,
      suggestedFrequency: 11,
      exceedsThreshold: true,
    });
  });

  it('reports an aligned rhythm as a real 0% reading with no suggestion', () => {
    const reading = computeScheduleDrift(
      't-1',
      7,
      [at(1), at(8), at(15), at(22)].map((completedAt) => ({ completedAt }))
    );
    expect(reading.drift).toEqual({
      medianIntervalDays: 7,
      driftPct: 0,
      suggestedFrequency: 7,
      exceedsThreshold: false,
    });
  });

  it('does not suggest when the drift exceeds 30% but rounds to the same frequency', () => {
    // 1.4-day median on a 1-day schedule: 40% drift, still "every day".
    const reading = computeScheduleDrift('t-1', 1, [
      { completedAt: '2026-08-01T00:00:00.000Z' },
      { completedAt: '2026-08-02T09:36:00.000Z' },
      { completedAt: '2026-08-03T19:12:00.000Z' },
      { completedAt: '2026-08-05T04:48:00.000Z' },
    ]);
    expect(reading.drift?.exceedsThreshold).toBe(false);
    expect(reading.drift?.suggestedFrequency).toBe(1);
  });

  it('excludes confirmed duplicates from the rhythm (and from the count)', () => {
    const reading = computeScheduleDrift('t-1', 7, [
      { completedAt: at(1) },
      { completedAt: at(1, 13), duplicateOfCompletionId: 'c-dup' },
      { completedAt: at(8) },
      { completedAt: at(15) },
      { completedAt: at(22) },
    ]);
    expect(reading.completionsConsidered).toBe(4);
    expect(reading.drift?.medianIntervalDays).toBe(7);
  });

  it('uses the median so one outlier does not move the reading', () => {
    const reading = computeScheduleDrift(
      't-1',
      7,
      [at(1), at(8), at(15), at(22), at(29 + 30)].map((completedAt) => ({
        completedAt: completedAt.replace('2026-08-59', '2026-09-28'),
      }))
    );
    expect(reading.drift?.medianIntervalDays).toBe(7);
    expect(reading.drift?.exceedsThreshold).toBe(false);
  });

  it('accepts unsorted input', () => {
    const reading = computeScheduleDrift(
      't-1',
      7,
      [at(22), at(1), at(15), at(8)].map((completedAt) => ({ completedAt }))
    );
    expect(reading.drift?.medianIntervalDays).toBe(7);
  });

  it('scheduleDriftUnavailable is the explicit failed-read shape', () => {
    expect(scheduleDriftUnavailable('t-1', 7)).toEqual({
      taskId: 't-1',
      scheduledIntervalDays: 7,
      completionsConsidered: 0,
      requiredCompletions: DRIFT_MIN_COMPLETIONS,
      drift: null,
      reason: 'history_unavailable',
    });
  });
});

describe('nextDueAfterMatch', () => {
  it('is null without a last completion (nothing to re-derive from)', () => {
    expect(nextDueAfterMatch(null, 11, NOW)).toBeNull();
  });

  it('is last completion + new interval when that is still ahead', () => {
    expect(nextDueAfterMatch('2026-09-01T09:00:00.000Z', 11, NOW)).toBe('2026-09-12T09:00:00.000Z');
  });

  it('floors at now so the tap never yields an instantly-overdue task', () => {
    expect(nextDueAfterMatch('2026-08-01T09:00:00.000Z', 4, NOW)).toBe(NOW.toISOString());
  });

  it('is null for an unparseable last completion', () => {
    expect(nextDueAfterMatch('never', 4, NOW)).toBeNull();
  });
});
