import { describe, expect, it } from 'vitest';
import {
  dayNumber,
  MIN_NOTICE_DAYS,
  validatePriceChangeAnnouncement,
  type PriceChangeAnnouncement,
} from '../../../src/models/priceChangeAnnouncement.js';

const BASE: PriceChangeAnnouncement = {
  id: 'garden-monthly-2026-11-01',
  planId: 'garden',
  interval: 'month',
  summary: 'Garden monthly is moving from $4.99 to $5.99 to keep pace with vendor cost.',
  oldPriceUsd: 4.99,
  newPriceUsd: 5.99,
  effectiveOn: '2026-11-01',
};
const TODAY = '2026-10-18'; // exactly 14 days before 2026-11-01

describe('dayNumber', () => {
  it('parses a real calendar date', () => {
    expect(dayNumber('2026-11-01')).not.toBeNull();
  });

  it('rejects an impossible date', () => {
    expect(dayNumber('2026-02-30')).toBeNull();
  });

  it('rejects a non-date string and non-strings', () => {
    expect(dayNumber('not-a-date')).toBeNull();
    expect(dayNumber(undefined)).toBeNull();
    expect(dayNumber(20_261_101)).toBeNull();
  });
});

describe('validatePriceChangeAnnouncement: the control', () => {
  it('passes a well-formed announcement exactly 14 days out', () => {
    expect(validatePriceChangeAnnouncement(BASE, TODAY)).toEqual([]);
  });

  it('passes further out than 14 days too', () => {
    expect(validatePriceChangeAnnouncement(BASE, '2026-09-01')).toEqual([]);
  });
});

describe('validatePriceChangeAnnouncement: each way it fails', () => {
  it('fails with no id', () => {
    const problems = validatePriceChangeAnnouncement({ ...BASE, id: '' }, TODAY);
    expect(problems.some((p) => p.includes('id is required'))).toBe(true);
  });

  it('fails on seedling — it has no price to change', () => {
    const problems = validatePriceChangeAnnouncement(
      { ...BASE, planId: 'seedling' as PriceChangeAnnouncement['planId'] },
      TODAY
    );
    expect(problems.some((p) => p.includes('planId'))).toBe(true);
  });

  it('fails on an unknown planId', () => {
    const problems = validatePriceChangeAnnouncement(
      { ...BASE, planId: 'bogus' as PriceChangeAnnouncement['planId'] },
      TODAY
    );
    expect(problems.some((p) => p.includes('planId'))).toBe(true);
  });

  it('fails on an interval that is neither month nor year', () => {
    const problems = validatePriceChangeAnnouncement(
      { ...BASE, interval: 'lifetime' as PriceChangeAnnouncement['interval'] },
      TODAY
    );
    expect(problems.some((p) => p.includes('interval'))).toBe(true);
  });

  it('fails on a summary that is too short to say what changed', () => {
    const problems = validatePriceChangeAnnouncement({ ...BASE, summary: 'price up' }, TODAY);
    expect(problems.some((p) => p.includes('summary'))).toBe(true);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('fails on oldPriceUsd = %s', (bad) => {
    const problems = validatePriceChangeAnnouncement({ ...BASE, oldPriceUsd: bad }, TODAY);
    expect(problems.some((p) => p.includes('oldPriceUsd'))).toBe(true);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('fails on newPriceUsd = %s', (bad) => {
    const problems = validatePriceChangeAnnouncement({ ...BASE, newPriceUsd: bad }, TODAY);
    expect(problems.some((p) => p.includes('newPriceUsd'))).toBe(true);
  });

  it('fails when the new price equals the old price — not a change', () => {
    const problems = validatePriceChangeAnnouncement(
      { ...BASE, newPriceUsd: BASE.oldPriceUsd },
      TODAY
    );
    expect(problems.some((p) => p.includes('not a price change'))).toBe(true);
  });

  it('fails on an impossible effectiveOn date', () => {
    const problems = validatePriceChangeAnnouncement({ ...BASE, effectiveOn: '2026-11-31' }, TODAY);
    expect(problems.some((p) => p.includes('effectiveOn'))).toBe(true);
  });

  it(`fails one day short of ${MIN_NOTICE_DAYS} days' notice`, () => {
    // 13 days between TODAY and effectiveOn.
    const problems = validatePriceChangeAnnouncement({ ...BASE, effectiveOn: '2026-10-31' }, TODAY);
    expect(problems.some((p) => p.includes('13 day(s)'))).toBe(true);
  });

  it('fails when effectiveOn is in the past relative to today', () => {
    const problems = validatePriceChangeAnnouncement({ ...BASE, effectiveOn: '2026-01-01' }, TODAY);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('fails when today itself is not a real date', () => {
    const problems = validatePriceChangeAnnouncement(BASE, 'not-a-date');
    expect(problems.some((p) => p.includes('today is not a calendar date'))).toBe(true);
  });
});
