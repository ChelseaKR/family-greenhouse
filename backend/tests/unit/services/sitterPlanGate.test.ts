import { describe, it, expect } from 'vitest';
import { PLANS } from '../../../src/models/plans.js';
import {
  checkSitterLinkPlanGate,
  countLiveSitterLinks,
  sitterWindowDays,
} from '../../../src/services/sitterPlanGate.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = '2026-09-03T12:00:00.000Z';
const plus = (days: number) => new Date(Date.parse(T0) + days * DAY_MS).toISOString();

describe('sitterPlanGate — the free/paid line for sitter links (ADR 0015)', () => {
  it('measures the window from startsAt, not from now', () => {
    expect(sitterWindowDays(plus(10), plus(17))).toBe(7);
    expect(sitterWindowDays(T0, plus(0.5))).toBe(0.5);
  });

  it('counts live links as active AND not yet ended (scheduled ones count)', () => {
    const now = new Date(T0);
    expect(
      countLiveSitterLinks(
        [
          { status: 'active', expiresAt: plus(3) }, // live
          { status: 'active', expiresAt: plus(30) }, // scheduled/live
          { status: 'active', expiresAt: plus(-1) }, // ended, TTL not swept
          { status: 'revoked', expiresAt: plus(3) }, // revoked
        ],
        now
      )
    ).toBe(2);
  });

  it('Seedling: one live link, seven days — an 8-day window is refused with the Garden number', () => {
    const r = checkSitterLinkPlanGate(PLANS.seedling, { windowDays: 8, liveLinks: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/Seedling plan allows sitter links of up to 7 days/);
      expect(r.message).toMatch(/Garden allows up to 90 days/);
    }
  });

  it('Seedling: exactly seven days is allowed, with a minute of clock-skew tolerance', () => {
    expect(checkSitterLinkPlanGate(PLANS.seedling, { windowDays: 7, liveLinks: 0 })).toEqual({
      ok: true,
    });
    expect(
      checkSitterLinkPlanGate(PLANS.seedling, { windowDays: 7 + 30 / 86400, liveLinks: 0 })
    ).toEqual({ ok: true });
  });

  it('Seedling: a second live link is refused, naming the cap and the upgrade', () => {
    const r = checkSitterLinkPlanGate(PLANS.seedling, { windowDays: 3, liveLinks: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/1 live sitter link at a time/);
      expect(r.message).toMatch(/upgrade to Garden/);
    }
  });

  it('Garden: 90-day windows and several links; the 91st day is refused without an upsell', () => {
    expect(checkSitterLinkPlanGate(PLANS.garden, { windowDays: 90, liveLinks: 9 })).toEqual({
      ok: true,
    });
    const r = checkSitterLinkPlanGate(PLANS.garden, { windowDays: 91, liveLinks: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/Garden plan allows sitter links of up to 90 days/);
      expect(r.message).not.toMatch(/upgrade/i);
    }
    const cap = checkSitterLinkPlanGate(PLANS.garden, { windowDays: 10, liveLinks: 10 });
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(cap.message).toMatch(/10 live sitter links at a time/);
  });

  it('Greenhouse: same window ceiling, more live links', () => {
    expect(checkSitterLinkPlanGate(PLANS.greenhouse, { windowDays: 90, liveLinks: 24 })).toEqual({
      ok: true,
    });
    expect(checkSitterLinkPlanGate(PLANS.greenhouse, { windowDays: 5, liveLinks: 25 }).ok).toBe(
      false
    );
  });
});
