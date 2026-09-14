/**
 * Gift checkout and redemption policy (ADR 0028).
 *
 * The Stripe SDK is a recorder, so a path that reached it is visible and a
 * path that must not is provable. Storage is mocked at `giftCodes`, so these
 * tests are about the DECISIONS: what the Session carries, and which
 * households may redeem. Synthetic fixtures only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sessionsCreate, pricesRetrieve } = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  pricesRetrieve: vi.fn(),
}));
vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return {
      checkout: { sessions: { create: sessionsCreate } },
      prices: { retrieve: pricesRetrieve },
    };
  }),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

// Same runtime-gate stand-in the billing service tests use.
vi.mock('../../../src/config/commercialStatus.js', () => ({
  assertPaymentActivityAllowed: () => {
    if (process.env.PAYMENTS_ENABLED !== '1') {
      const error = new Error('Payment activity is disabled') as Error & { code?: string };
      error.code = 'PAYMENTS_DISABLED';
      throw error;
    }
  },
}));

vi.mock('../../../src/services/billing.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/billing.js')>(
    '../../../src/services/billing.js'
  );
  return { ...actual, getHouseholdSubscription: vi.fn() };
});
vi.mock('../../../src/services/giftCodes.js', () => ({
  findGiftByCode: vi.fn(),
  redeemGift: vi.fn(),
}));

import { getHouseholdSubscription } from '../../../src/services/billing.js';
import { findGiftByCode, redeemGift, type GiftRecord } from '../../../src/services/giftCodes.js';
import {
  GiftRedeemError,
  createGiftCheckoutSession,
  redeemGiftCode,
} from '../../../src/services/giftSubscriptions.js';
import { isPriceReconciliationError } from '../../../src/services/stripePrices.js';

/** What Stripe reports for a correctly configured gift month of Garden. */
const GARDEN_GIFT_PRICE = {
  id: 'price_gift_garden',
  unit_amount: 499,
  currency: 'usd',
  active: true,
  recurring: null,
};

const ARGS = {
  buyerUserId: 'user-buyer',
  buyerEmail: 'buyer@example.test',
  planId: 'garden' as const,
  months: 3,
  successUrl: 's',
  cancelUrl: 'c',
};

describe('createGiftCheckoutSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYMENTS_ENABLED = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_ID_GIFT_GARDEN_MONTH = 'price_gift_garden';
    delete process.env.STRIPE_PRICE_ID_GIFT_GREENHOUSE_MONTH;
    pricesRetrieve.mockResolvedValue(GARDEN_GIFT_PRICE);
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/gift' });
  });

  afterEach(() => {
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.STRIPE_PRICE_ID_GIFT_GARDEN_MONTH;
    delete process.env.STRIPE_PRICE_ID_GIFT_GREENHOUSE_MONTH;
  });

  it('refuses before Stripe while payment activity is paused', async () => {
    process.env.PAYMENTS_ENABLED = '0';
    await expect(createGiftCheckoutSession(ARGS)).rejects.toMatchObject({
      code: 'PAYMENTS_DISABLED',
    });
    expect(pricesRetrieve).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('refuses months outside 1..12 before Stripe', async () => {
    for (const months of [0, 13, 2.5, Number.NaN]) {
      await expect(createGiftCheckoutSession({ ...ARGS, months })).rejects.toThrow(
        /^GIFT_MONTHS_INVALID/
      );
    }
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('fails CLOSED on an unconfigured tier: no fallback price, nothing reaches Stripe', async () => {
    await expect(createGiftCheckoutSession({ ...ARGS, planId: 'greenhouse' })).rejects.toThrow(
      /^GIFT_NOT_CONFIGURED: STRIPE_PRICE_ID_GIFT_GREENHOUSE_MONTH is not set/
    );
    expect(pricesRetrieve).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('reconciles the gift price against the tier’s monthly price and refuses a recurring or mispriced one', async () => {
    pricesRetrieve.mockResolvedValueOnce({
      ...GARDEN_GIFT_PRICE,
      recurring: { interval: 'month', interval_count: 1 },
    });
    await expect(createGiftCheckoutSession(ARGS)).rejects.toSatisfy(isPriceReconciliationError);
    pricesRetrieve.mockResolvedValueOnce({ ...GARDEN_GIFT_PRICE, unit_amount: 3999 });
    await expect(createGiftCheckoutSession(ARGS)).rejects.toSatisfy(isPriceReconciliationError);
    pricesRetrieve.mockRejectedValueOnce(new Error('No such price'));
    await expect(createGiftCheckoutSession(ARGS)).rejects.toSatisfy(isPriceReconciliationError);
    expect(pricesRetrieve).toHaveBeenCalledWith('price_gift_garden');
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('mints a one-time Session on the buyer’s own card, quantity = months, naming NO household', async () => {
    await expect(
      createGiftCheckoutSession({ ...ARGS, idempotencyKey: 'gift:user-buyer:attempt-1' })
    ).resolves.toEqual({ url: 'https://checkout.stripe.test/gift' });
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params, options] = sessionsCreate.mock.calls[0];
    expect(params).toEqual({
      mode: 'payment',
      customer_email: 'buyer@example.test',
      line_items: [{ price: 'price_gift_garden', quantity: 3 }],
      success_url: 's',
      cancel_url: 'c',
      metadata: {
        purchase: 'gift_subscription',
        giftPlanId: 'garden',
        months: '3',
        buyerUserId: 'user-buyer',
      },
      automatic_tax: { enabled: false },
    });
    // The two fields every household-facing reader keys on are absent, and
    // no Stripe customer is attached — the buyer's household's saved card
    // must never be offered for a purchase that is not the household's.
    expect(params).not.toHaveProperty('customer');
    expect(params).not.toHaveProperty('client_reference_id');
    expect(params.metadata).not.toHaveProperty('householdId');
    expect(params.metadata).not.toHaveProperty('planId');
    expect(params).not.toHaveProperty('subscription_data');
    expect(options).toEqual({ idempotencyKey: 'gift:user-buyer:attempt-1' });
    // The household row is never read for a gift purchase.
    expect(getHouseholdSubscription).not.toHaveBeenCalled();
  });

  it('never opens a Session without a URL to send the buyer to', async () => {
    sessionsCreate.mockResolvedValueOnce({ url: null });
    await expect(createGiftCheckoutSession(ARGS)).rejects.toThrow(/did not return a checkout URL/);
  });
});

const CODE = 'FG-0123-4567-89AB-CDEF';
const NOW = new Date('2026-10-01T09:30:00.000Z');
const gift = (over: Partial<GiftRecord> = {}): GiftRecord => ({
  stripeSessionId: 'cs_gift_1',
  planId: 'garden',
  months: 3,
  buyerUserId: 'user-buyer',
  codeHash: 'h'.repeat(64),
  purchasedAt: '2026-09-13T12:00:00.000Z',
  redeemBy: '2027-09-13T12:00:00.000Z',
  redeemByEpoch: Math.floor(Date.parse('2027-09-13T12:00:00.000Z') / 1000),
  ...over,
});

const refusal = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toBeInstanceOf(GiftRedeemError);
  await expect(promise).rejects.toMatchObject({ code });
};

describe('redeemGiftCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHouseholdSubscription).mockResolvedValue({ planId: 'seedling' });
    vi.mocked(findGiftByCode).mockResolvedValue(gift());
    vi.mocked(redeemGift).mockResolvedValue('redeemed');
  });

  it('places the gift on the household from now for the gift’s months, consuming the code in the same write', async () => {
    await expect(
      redeemGiftCode({ code: ' fg-0123 4567-89ab-cdef ', householdId: 'hh-9', now: NOW })
    ).resolves.toEqual({ planId: 'garden', endsAt: '2027-01-01T09:30:00.000Z' });
    expect(findGiftByCode).toHaveBeenCalledWith('FG0123456789ABCDEF');
    expect(redeemGift).toHaveBeenCalledWith({
      gift: gift(),
      householdId: 'hh-9',
      endsAt: new Date('2027-01-01T09:30:00.000Z'),
      now: NOW,
      liveSubscriptionStatuses: ['active', 'trialing', 'past_due', 'unpaid', 'paused'],
    });
  });

  it('refuses a malformed code without looking it up', async () => {
    await refusal(redeemGiftCode({ code: 'not a code', householdId: 'hh-9' }), 'GIFT_CODE_INVALID');
    await refusal(redeemGiftCode({ code: 42, householdId: 'hh-9' }), 'GIFT_CODE_INVALID');
    expect(findGiftByCode).not.toHaveBeenCalled();
  });

  it('gives one answer for an unknown code, so the endpoint is not an oracle for which codes exist', async () => {
    vi.mocked(findGiftByCode).mockResolvedValue(null);
    await refusal(redeemGiftCode({ code: CODE, householdId: 'hh-9' }), 'GIFT_CODE_INVALID');
  });

  it('refuses a code already redeemed, or past its redeem-by date, naming the date', async () => {
    vi.mocked(findGiftByCode).mockResolvedValue(gift({ redeemedAt: '2026-09-20T00:00:00.000Z' }));
    await refusal(
      redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW }),
      'GIFT_CODE_REDEEMED'
    );
    vi.mocked(findGiftByCode).mockResolvedValue(gift());
    const late = redeemGiftCode({
      code: CODE,
      householdId: 'hh-9',
      now: new Date('2027-09-13T12:00:00.000Z'),
    });
    await refusal(late, 'GIFT_CODE_EXPIRED');
    await expect(late).rejects.toMatchObject({ details: { redeemBy: '2027-09-13T12:00:00.000Z' } });
  });

  it('refuses a household with a live Stripe subscription — including one whose status is not yet known', async () => {
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', undefined]) {
      vi.mocked(getHouseholdSubscription).mockResolvedValue({
        planId: 'garden',
        stripeSubscriptionId: 'sub_1',
        status,
      });
      await refusal(
        redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW }),
        'GIFT_HOUSEHOLD_SUBSCRIBED'
      );
    }
    expect(redeemGift).not.toHaveBeenCalled();
  });

  it('allows a household whose subscription is known-dead', async () => {
    vi.mocked(getHouseholdSubscription).mockResolvedValue({
      planId: 'seedling',
      stripeSubscriptionId: 'sub_old',
      status: 'canceled',
    });
    await expect(
      redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW })
    ).resolves.toMatchObject({
      planId: 'garden',
    });
  });

  it('refuses a gift that adds nothing to a lifetime tier, and allows one that raises it', async () => {
    vi.mocked(getHouseholdSubscription).mockResolvedValue({
      planId: 'garden',
      lifetimePlanId: 'garden',
    });
    await refusal(
      redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW }),
      'GIFT_ADDS_NOTHING'
    );
    vi.mocked(findGiftByCode).mockResolvedValue(gift({ planId: 'greenhouse' }));
    await expect(
      redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW })
    ).resolves.toMatchObject({
      planId: 'greenhouse',
    });
  });

  it('refuses while another gift is running, naming when it ends; allows once it has ended', async () => {
    vi.mocked(getHouseholdSubscription).mockResolvedValue({
      planId: 'seedling',
      giftPlanId: 'garden',
      giftEndsAt: '2026-12-01T00:00:00.000Z',
    });
    const running = redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW });
    await refusal(running, 'GIFT_ALREADY_ACTIVE');
    await expect(running).rejects.toMatchObject({
      details: { endsAt: '2026-12-01T00:00:00.000Z' },
    });
    await expect(
      redeemGiftCode({ code: CODE, householdId: 'hh-9', now: new Date('2026-12-02T00:00:00.000Z') })
    ).resolves.toMatchObject({ planId: 'garden' });
  });

  it('never touches the card trial: a redemption reads no trialConsumedAt and writes none', async () => {
    vi.mocked(getHouseholdSubscription).mockResolvedValue({
      planId: 'seedling',
      trialAvailable: true,
      noCardTrialEndsAt: '2026-10-10T00:00:00.000Z',
    });
    await expect(
      redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW })
    ).resolves.toMatchObject({
      planId: 'garden',
    });
    const write = vi.mocked(redeemGift).mock.calls[0][0];
    expect(JSON.stringify(write)).not.toMatch(/trialConsumedAt|trialAvailable|noCardTrial/);
  });

  it('maps a write-time conflict to the refusal it stands for, and consumes nothing on either', async () => {
    vi.mocked(redeemGift).mockResolvedValueOnce('code_conflict');
    await refusal(
      redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW }),
      'GIFT_CODE_REDEEMED'
    );
    vi.mocked(redeemGift).mockResolvedValueOnce('household_conflict');
    await refusal(
      redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW }),
      'GIFT_REDEEM_CONFLICT'
    );
  });

  it('never reaches Stripe', async () => {
    await redeemGiftCode({ code: CODE, householdId: 'hh-9', now: NOW });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(pricesRetrieve).not.toHaveBeenCalled();
  });
});
