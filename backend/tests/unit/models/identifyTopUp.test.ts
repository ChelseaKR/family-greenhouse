import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Stripe from 'stripe';
import { PLANT_ID_USD_PER_CREDIT } from '../../../src/config/upstreamCosts.js';
import {
  IDENTIFY_TOP_UP_PACK,
  IDENTIFY_TOP_UP_PURCHASE_KIND,
  identifyTopUpGrantFromEvent,
  identifyTopUpPriceId,
  identifyTopUpSummary,
  isIdentifyTopUpConfigured,
  isIdentifyTopUpSession,
} from '../../../src/models/identifyTopUp.js';

function topUpEvent(overrides: {
  type?: string;
  mode?: string;
  payment_status?: string;
  metadata?: Record<string, string> | null;
  id?: string;
  client_reference_id?: string | null;
  created?: number;
}): Stripe.Event {
  const {
    type = 'checkout.session.completed',
    mode = 'payment',
    payment_status = 'paid',
    metadata = { householdId: 'hh-1', purchase: IDENTIFY_TOP_UP_PURCHASE_KIND, credits: '20' },
    id = 'cs_test_1',
    client_reference_id = null,
    created = 1_756_857_600,
  } = overrides;
  return {
    id: 'evt_1',
    type,
    created,
    data: { object: { id, mode, payment_status, metadata, client_reference_id } },
  } as unknown as Stripe.Event;
}

describe('identifyTopUp model', () => {
  beforeEach(() => {
    delete process.env[IDENTIFY_TOP_UP_PACK.stripePriceEnv];
  });
  afterEach(() => {
    delete process.env[IDENTIFY_TOP_UP_PACK.stripePriceEnv];
  });

  it('is the pack ADR 0019 prices: 20 identifications for $1.99, valid 12 months', () => {
    expect(IDENTIFY_TOP_UP_PACK).toMatchObject({
      credits: 20,
      priceUsd: 1.99,
      validityDays: 365,
      stripePriceEnv: 'STRIPE_PRICE_ID_IDENTIFY_TOP_UP',
    });
  });

  it('stays margin-positive at the recorded per-identification cost, before and after Stripe', () => {
    // The whole point of the pack: consumption is priced, not subsidised.
    // Vendor cost of a pack must sit below the price (gross), and below the
    // price net of Stripe's 2.9% + $0.30 (the number the owner actually keeps).
    const vendorCost = IDENTIFY_TOP_UP_PACK.credits * PLANT_ID_USD_PER_CREDIT;
    const stripeFee = IDENTIFY_TOP_UP_PACK.priceUsd * 0.029 + 0.3;
    expect(vendorCost).toBeCloseTo(1.17, 2);
    expect(IDENTIFY_TOP_UP_PACK.priceUsd - vendorCost).toBeGreaterThan(0);
    expect(IDENTIFY_TOP_UP_PACK.priceUsd - stripeFee - vendorCost).toBeGreaterThan(0);
    // The ADR's stated figures: ~41% gross, ~$0.46 net per pack.
    expect(
      (IDENTIFY_TOP_UP_PACK.priceUsd - vendorCost) / IDENTIFY_TOP_UP_PACK.priceUsd
    ).toBeCloseTo(0.412, 2);
    expect(IDENTIFY_TOP_UP_PACK.priceUsd - stripeFee - vendorCost).toBeCloseTo(0.46, 2);
  });

  describe('price configuration fails closed', () => {
    it.each([undefined, '', '   '])('treats %j as not configured', (value) => {
      if (value === undefined) delete process.env[IDENTIFY_TOP_UP_PACK.stripePriceEnv];
      else process.env[IDENTIFY_TOP_UP_PACK.stripePriceEnv] = value;
      expect(identifyTopUpPriceId()).toBeUndefined();
      expect(isIdentifyTopUpConfigured()).toBe(false);
    });

    it('returns the trimmed price id when set', () => {
      process.env[IDENTIFY_TOP_UP_PACK.stripePriceEnv] = ' price_topup ';
      expect(identifyTopUpPriceId()).toBe('price_topup');
      expect(isIdentifyTopUpConfigured()).toBe(true);
    });
  });

  describe('identifyTopUpSummary', () => {
    it('withholds the amount and is unavailable while payments are off', () => {
      process.env[IDENTIFY_TOP_UP_PACK.stripePriceEnv] = 'price_topup';
      expect(identifyTopUpSummary(false)).toEqual({
        available: false,
        credits: 20,
        validityDays: 365,
      });
    });

    it('publishes the amount but stays unavailable when no price is configured', () => {
      expect(identifyTopUpSummary(true)).toEqual({
        available: false,
        credits: 20,
        validityDays: 365,
        priceUsd: 1.99,
      });
    });

    it('is available only when payments are on AND a price is configured', () => {
      process.env[IDENTIFY_TOP_UP_PACK.stripePriceEnv] = 'price_topup';
      expect(identifyTopUpSummary(true)).toEqual({
        available: true,
        credits: 20,
        validityDays: 365,
        priceUsd: 1.99,
      });
    });
  });

  describe('identifyTopUpGrantFromEvent', () => {
    it('describes the grant for a PAID top-up checkout', () => {
      expect(identifyTopUpGrantFromEvent(topUpEvent({}))).toEqual({
        householdId: 'hh-1',
        stripeSessionId: 'cs_test_1',
        credits: 20,
        purchasedAt: new Date(1_756_857_600 * 1000).toISOString(),
      });
    });

    it('grants on the later async_payment_succeeded for deferred payment methods', () => {
      expect(
        identifyTopUpGrantFromEvent(
          topUpEvent({ type: 'checkout.session.async_payment_succeeded' })
        )
      ).toMatchObject({ stripeSessionId: 'cs_test_1', credits: 20 });
    });

    it('does NOT grant on an unpaid completed session', () => {
      expect(identifyTopUpGrantFromEvent(topUpEvent({ payment_status: 'unpaid' }))).toBeNull();
    });

    it('ignores a lifetime (mode=payment) purchase — no top-up marker', () => {
      expect(
        identifyTopUpGrantFromEvent(
          topUpEvent({ metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' } })
        )
      ).toBeNull();
      expect(isIdentifyTopUpSession({ metadata: { planId: 'garden' } })).toBe(false);
      expect(isIdentifyTopUpSession({ metadata: { purchase: 'identify_top_up' } })).toBe(true);
    });

    it('ignores subscription-mode sessions and unrelated event types', () => {
      expect(identifyTopUpGrantFromEvent(topUpEvent({ mode: 'subscription' }))).toBeNull();
      expect(
        identifyTopUpGrantFromEvent(topUpEvent({ type: 'customer.subscription.updated' }))
      ).toBeNull();
    });

    it('falls back to client_reference_id for the household, and refuses when neither is present', () => {
      expect(
        identifyTopUpGrantFromEvent(
          topUpEvent({
            metadata: { purchase: IDENTIFY_TOP_UP_PURCHASE_KIND, credits: '20' },
            client_reference_id: 'hh-9',
          })
        )
      ).toMatchObject({ householdId: 'hh-9' });
      expect(
        identifyTopUpGrantFromEvent(
          topUpEvent({ metadata: { purchase: IDENTIFY_TOP_UP_PURCHASE_KIND, credits: '20' } })
        )
      ).toBeNull();
    });

    it.each(['', 'twenty', '0', '-5', '2.5', '5000'])(
      'refuses to invent a grant when the stamped credits are %j',
      (credits) => {
        expect(
          identifyTopUpGrantFromEvent(
            topUpEvent({
              metadata: { householdId: 'hh-1', purchase: IDENTIFY_TOP_UP_PURCHASE_KIND, credits },
            })
          )
        ).toBeNull();
      }
    );

    it('refuses a session with no id — there would be nothing to key the grant on', () => {
      expect(identifyTopUpGrantFromEvent(topUpEvent({ id: '' }))).toBeNull();
    });
  });
});
