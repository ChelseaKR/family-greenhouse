import { describe, expect, it } from 'vitest';
import {
  CHECK_SOON_DAYS,
  CHECK_UNSURE_DAYS,
  LAST_WATERED_ANSWERS,
  firstCheckDue,
  firstCheckInDays,
} from '@/features/onboarding/firstWatering';
import { COMMON_PLANTS } from '@/features/onboarding/commonPlants';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-05T18:00:00.000Z');
/** The no-card Garden trial (backend NO_CARD_TRIAL_DAYS). */
const TRIAL_DAYS = 14;

describe('firstCheckInDays', () => {
  it('keeps one interval for a plant watered in the last few days', () => {
    expect(firstCheckInDays(14, 'recent')).toBe(14);
    expect(firstCheckInDays(7, 'recent')).toBe(7);
  });

  it('checks in 2 days after a week or more, and tomorrow when not sure', () => {
    expect(firstCheckInDays(14, 'while_ago')).toBe(CHECK_SOON_DAYS);
    expect(firstCheckInDays(14, 'unsure')).toBe(CHECK_UNSURE_DAYS);
    expect(CHECK_SOON_DAYS).toBe(2);
    expect(CHECK_UNSURE_DAYS).toBe(1);
  });

  it('never schedules today, and never later than one interval, for any plant', () => {
    for (const plant of COMMON_PLANTS) {
      for (const last of LAST_WATERED_ANSWERS) {
        const days = firstCheckInDays(plant.waterEveryDays, last);
        expect(days).toBeGreaterThanOrEqual(1);
        expect(days).toBeLessThanOrEqual(plant.waterEveryDays);
      }
    }
  });

  it('lands inside the trial for every 14-day plant unless it was just watered', () => {
    for (const plant of COMMON_PLANTS.filter((p) => p.waterEveryDays === 14)) {
      expect(firstCheckInDays(plant.waterEveryDays, 'while_ago')).toBeLessThan(TRIAL_DAYS);
      expect(firstCheckInDays(plant.waterEveryDays, 'unsure')).toBeLessThan(TRIAL_DAYS);
    }
  });

  it('gives each answer a different first date (negative control)', () => {
    // If two answers collapsed to the same date, the question would be
    // decoration. This would fail if the mapping were flattened to one value.
    const dates = LAST_WATERED_ANSWERS.map((last) => firstCheckInDays(14, last));
    expect(new Set(dates).size).toBe(LAST_WATERED_ANSWERS.length);
  });
});

describe('firstCheckDue', () => {
  it('is an ISO date that many days from now', () => {
    expect(firstCheckDue(14, 'unsure', NOW)).toBe(new Date(NOW + DAY_MS).toISOString());
    expect(firstCheckDue(14, 'while_ago', NOW)).toBe(new Date(NOW + 2 * DAY_MS).toISOString());
    expect(firstCheckDue(14, 'recent', NOW)).toBe(new Date(NOW + 14 * DAY_MS).toISOString());
  });
});
