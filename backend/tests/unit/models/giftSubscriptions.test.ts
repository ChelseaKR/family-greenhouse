/**
 * The gift subscription model (ADR 0028): the offer, the code, the month
 * arithmetic, and the projection from a Stripe event to a grant.
 *
 * Every assertion pins a value. Synthetic fixtures only — no code here is a
 * real one, and the generated codes are never printed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type Stripe from 'stripe';
import {
  GIFT_MAX_MONTHS,
  GIFT_MIN_MONTHS,
  GIFT_PRICE_ENV,
  GIFT_REDEEM_WINDOW_DAYS,
  GIFT_SUBSCRIPTION_PURCHASE_KIND,
  addCalendarMonthsUtc,
  formatGiftCode,
  generateGiftCode,
  giftAmountCents,
  giftPurchaseFromEvent,
  giftSubscriptionSummary,
  hashGiftCode,
  isGiftSession,
  isGiftablePlanId,
  isValidGiftMonths,
  normalizeGiftCode,
} from '../../../src/models/giftSubscriptions.js';
import { PLANS } from '../../../src/models/plans.js';

describe('gift subscriptions: the constants are the decision', () => {
  it('sells 1 to 12 months, redeemable for a year, of the two paid tiers only', () => {
    expect(GIFT_MIN_MONTHS).toBe(1);
    expect(GIFT_MAX_MONTHS).toBe(12);
    expect(GIFT_REDEEM_WINDOW_DAYS).toBe(365);
    expect(isGiftablePlanId('garden')).toBe(true);
    expect(isGiftablePlanId('greenhouse')).toBe(true);
    expect(isGiftablePlanId('seedling')).toBe(false);
    expect(isGiftablePlanId('toString')).toBe(false);
  });

  it('prices a gift at the monthly price times the months, in integer cents, with no discount', () => {
    // 4.99 * 3 is 14.970000000000002 in floating point; the catalog must
    // publish 1497. And twelve months is twelve monthlies, NOT the withdrawn
    // annual price (ADR 0012).
    expect(giftAmountCents('garden', 3)).toBe(1497);
    expect(giftAmountCents('garden', 12)).toBe(Math.round(PLANS.garden.monthlyPrice * 100) * 12);
    expect(giftAmountCents('garden', 12)).not.toBe(
      Math.round((PLANS.garden.annualPrice ?? 0) * 100)
    );
    expect(giftAmountCents('greenhouse', 1)).toBe(999);
  });

  it('bounds the months as an integer inside the range', () => {
    expect(isValidGiftMonths(1)).toBe(true);
    expect(isValidGiftMonths(12)).toBe(true);
    expect(isValidGiftMonths(0)).toBe(false);
    expect(isValidGiftMonths(13)).toBe(false);
    expect(isValidGiftMonths(2.5)).toBe(false);
    expect(isValidGiftMonths('3')).toBe(false);
    expect(isValidGiftMonths(Number.NaN)).toBe(false);
  });
});

describe('gift subscriptions: the offer is fail-closed on both gates', () => {
  afterEach(() => {
    delete process.env.STRIPE_PRICE_ID_GIFT_GARDEN_MONTH;
    delete process.env.STRIPE_PRICE_ID_GIFT_GREENHOUSE_MONTH;
  });

  it('is unavailable per tier until that tier has a price AND payments are on', () => {
    process.env.STRIPE_PRICE_ID_GIFT_GARDEN_MONTH = 'price_gift_garden';
    expect(giftSubscriptionSummary(true)).toEqual({
      minMonths: 1,
      maxMonths: 12,
      redeemWindowDays: 365,
      plans: [
        { planId: 'garden', available: true },
        { planId: 'greenhouse', available: false },
      ],
    });
    // Payments off: nothing is available, whatever is configured.
    expect(giftSubscriptionSummary(false).plans.every((p) => !p.available)).toBe(true);
  });

  it('treats a blank or whitespace price id as unset', () => {
    process.env.STRIPE_PRICE_ID_GIFT_GREENHOUSE_MONTH = '   ';
    expect(giftSubscriptionSummary(true).plans[1]).toEqual({
      planId: 'greenhouse',
      available: false,
    });
    expect(GIFT_PRICE_ENV.greenhouse).toBe('STRIPE_PRICE_ID_GIFT_GREENHOUSE_MONTH');
  });
});

describe('gift codes', () => {
  it('generates FG + 16 Crockford symbols, distinct each time, from the CSPRNG', () => {
    const a = generateGiftCode();
    const b = generateGiftCode();
    expect(a).toMatch(/^FG[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(b).toMatch(/^FG[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(a).not.toBe(b);
    // Round-trips through the display form and the normaliser unchanged.
    expect(normalizeGiftCode(formatGiftCode(a))).toBe(a);
  });

  it('formats as FG-XXXX-XXXX-XXXX-XXXX', () => {
    expect(formatGiftCode('FG0123456789ABCDEF')).toBe('FG-0123-4567-89AB-CDEF');
  });

  it('normalises case, separators and the Crockford confusables, and refuses anything else', () => {
    const canonical = 'FG0123456789ABCDEF';
    expect(normalizeGiftCode(' fg-0123 4567_89ab-cdef ')).toBe(canonical);
    // O→0, I→1, L→1: a code read off a card with the letter O typed for zero.
    expect(normalizeGiftCode('FG-O123-4567-89AB-CDEF')).toBe(canonical);
    expect(normalizeGiftCode('FGO1234567 89ABCDEF')).toBe(canonical);
    // Wrong prefix, wrong length, symbols outside the alphabet, non-strings.
    expect(normalizeGiftCode('XX0123456789ABCDEF')).toBeNull();
    expect(normalizeGiftCode('FG0123456789ABCDE')).toBeNull();
    expect(normalizeGiftCode('FG0123456789ABCDEFG')).toBeNull();
    expect(normalizeGiftCode('FG0123456789ABCDEU')).toBeNull();
    expect(normalizeGiftCode('')).toBeNull();
    expect(normalizeGiftCode(null)).toBeNull();
    expect(normalizeGiftCode(42)).toBeNull();
  });

  it('hashes deterministically to a 64-hex lookup key that does not contain the code', () => {
    const code = 'FG0123456789ABCDEF';
    const hash = hashGiftCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGiftCode(code)).toBe(hash);
    expect(hashGiftCode('FG0123456789ABCDEG')).not.toBe(hash);
    expect(hash.toUpperCase()).not.toContain('0123456789ABCDEF');
  });
});

describe('addCalendarMonthsUtc', () => {
  const iso = (s: string) => new Date(s);

  it('adds whole calendar months and keeps the time of day', () => {
    expect(addCalendarMonthsUtc(iso('2026-09-13T14:05:09.250Z'), 1).toISOString()).toBe(
      '2026-10-13T14:05:09.250Z'
    );
    expect(addCalendarMonthsUtc(iso('2026-09-13T14:05:09.250Z'), 12).toISOString()).toBe(
      '2027-09-13T14:05:09.250Z'
    );
  });

  it('clamps to the target month’s length instead of rolling into the next month', () => {
    // 31 January + 1 month is the last day of February, not 3 March.
    expect(addCalendarMonthsUtc(iso('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z'
    );
    expect(addCalendarMonthsUtc(iso('2028-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    );
    expect(addCalendarMonthsUtc(iso('2026-03-31T23:59:59.999Z'), 6).toISOString()).toBe(
      '2026-09-30T23:59:59.999Z'
    );
  });

  it('crosses a year boundary', () => {
    expect(addCalendarMonthsUtc(iso('2026-11-30T12:00:00.000Z'), 3).toISOString()).toBe(
      '2027-02-28T12:00:00.000Z'
    );
  });
});

describe('giftPurchaseFromEvent', () => {
  const created = 1_757_721_600; // 2025-09-13T00:00:00Z as a unix second
  const session = (over: Record<string, unknown> = {}) =>
    ({
      id: 'evt_gift_1',
      created,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_gift_1',
          mode: 'payment',
          payment_status: 'paid',
          metadata: {
            purchase: GIFT_SUBSCRIPTION_PURCHASE_KIND,
            giftPlanId: 'garden',
            months: '3',
            buyerUserId: 'user-buyer',
          },
          ...over,
        },
      },
    }) as unknown as Stripe.Event;

  it('projects a PAID gift checkout into a grant read entirely from our own metadata', () => {
    expect(giftPurchaseFromEvent(session())).toEqual({
      stripeSessionId: 'cs_gift_1',
      planId: 'garden',
      months: 3,
      buyerUserId: 'user-buyer',
      purchasedAt: new Date(created * 1000).toISOString(),
    });
    expect(isGiftSession({ metadata: { purchase: GIFT_SUBSCRIPTION_PURCHASE_KIND } })).toBe(true);
    expect(isGiftSession({ metadata: { purchase: 'identify_top_up' } })).toBe(false);
    expect(isGiftSession({ metadata: null })).toBe(false);
  });

  it('also grants on the async event that settles a deferred payment method', () => {
    const evt = session();
    (evt as unknown as { type: string }).type = 'checkout.session.async_payment_succeeded';
    expect(giftPurchaseFromEvent(evt)?.months).toBe(3);
  });

  it('grants nothing until the session is paid, and nothing for other events or purchases', () => {
    expect(giftPurchaseFromEvent(session({ payment_status: 'unpaid' }))).toBeNull();
    expect(giftPurchaseFromEvent(session({ mode: 'subscription' }))).toBeNull();
    expect(
      giftPurchaseFromEvent(session({ metadata: { purchase: 'identify_top_up', credits: '20' } }))
    ).toBeNull();
    const other = session();
    (other as unknown as { type: string }).type = 'customer.subscription.updated';
    expect(giftPurchaseFromEvent(other)).toBeNull();
  });

  it('refuses to invent a gift from broken metadata: no tier, a free tier, bad months, no buyer, no id', () => {
    const meta = (m: Record<string, string>) =>
      session({ metadata: { purchase: 'gift_subscription', ...m } });
    expect(giftPurchaseFromEvent(meta({ months: '3', buyerUserId: 'u' }))).toBeNull();
    expect(
      giftPurchaseFromEvent(meta({ giftPlanId: 'seedling', months: '3', buyerUserId: 'u' }))
    ).toBeNull();
    expect(
      giftPurchaseFromEvent(meta({ giftPlanId: 'garden', months: '0', buyerUserId: 'u' }))
    ).toBeNull();
    expect(
      giftPurchaseFromEvent(meta({ giftPlanId: 'garden', months: '13', buyerUserId: 'u' }))
    ).toBeNull();
    expect(
      giftPurchaseFromEvent(meta({ giftPlanId: 'garden', months: 'three', buyerUserId: 'u' }))
    ).toBeNull();
    expect(giftPurchaseFromEvent(meta({ giftPlanId: 'garden', months: '3' }))).toBeNull();
    expect(giftPurchaseFromEvent(session({ id: '' }))).toBeNull();
    // A plain `planId` key is NOT a gift tier: every existing reader of that
    // key would treat the session as a plan purchase for a household.
    expect(
      giftPurchaseFromEvent(meta({ planId: 'garden', months: '3', buyerUserId: 'u' }))
    ).toBeNull();
  });
});
