import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  CATALOG_CURRENCY,
  PriceReconciliationError,
  assertPriceMatchesCatalog,
  comparePriceToCatalog,
  expectedPriceFor,
  expectedPrices,
  isPriceReconciliationError,
  reconcileConfiguredPrices,
  reconcilePrice,
  unitAmountFor,
  type ExpectedPrice,
} from '../../../src/services/stripePrices.js';
import { PLANS } from '../../../src/models/plans.js';

/**
 * These tests never construct a Stripe client and never carry a key. The
 * client is injected, so the ASSERTION logic below is the real one — only the
 * retrieval is faked.
 */
function fakeStripe(prices: Record<string, Partial<Stripe.Price> | Error>) {
  const retrieve = vi.fn((id: string) => {
    const price = prices[id];
    if (price === undefined) return Promise.reject(new Error(`No such price: ${id}`));
    if (price instanceof Error) return Promise.reject(price);
    return Promise.resolve({ id, ...price } as Stripe.Price);
  });
  return { stripe: { prices: { retrieve } } as unknown as Pick<Stripe, 'prices'>, retrieve };
}

function priceLike(over: Partial<Stripe.Price> = {}): Partial<Stripe.Price> {
  return {
    unit_amount: 499,
    currency: 'usd',
    active: true,
    recurring: { interval: 'month', interval_count: 1 } as Stripe.Price.Recurring,
    ...over,
  };
}

const GARDEN_MONTHLY = expectedPriceFor('garden', 'month') as ExpectedPrice;

describe('catalog expansion', () => {
  it('converts dollars to cents without floating-point drift', () => {
    // 4.99 * 100 is 499.00000000000006 in IEEE 754; Stripe reports 499.
    expect(unitAmountFor(4.99)).toBe(499);
    expect(unitAmountFor(39.99)).toBe(3999);
    expect(unitAmountFor(9.99)).toBe(999);
    expect(unitAmountFor(79.99)).toBe(7999);
    expect(unitAmountFor(149)).toBe(14900);
  });

  it('expands exactly the five sellable amounts and skips the free tier', () => {
    const rows = expectedPrices().map((r) => `${r.planId}:${r.cadence}`);
    expect(rows.sort()).toEqual([
      'garden:lifetime',
      'garden:month',
      'garden:year',
      'greenhouse:month',
      'greenhouse:year',
    ]);
  });

  it('derives the expected amounts from plans.ts rather than restating them', () => {
    // Reading through PLANS is the point: if someone edits the catalog, this
    // reconciliation follows, instead of silently checking a stale copy.
    expect(expectedPriceFor('garden', 'month')).toMatchObject({
      env: 'STRIPE_PRICE_ID_GARDEN',
      dollars: PLANS.garden.monthlyPrice,
      unitAmount: unitAmountFor(PLANS.garden.monthlyPrice),
    });
    expect(expectedPriceFor('greenhouse', 'year')).toMatchObject({
      env: 'STRIPE_PRICE_ID_GREENHOUSE_ANNUAL',
      unitAmount: unitAmountFor(PLANS.greenhouse.annualPrice!),
    });
  });

  it('has no lifetime row for a tier that does not sell one', () => {
    expect(expectedPriceFor('greenhouse', 'lifetime')).toBeNull();
    expect(expectedPriceFor('seedling', 'month')).toBeNull();
  });
});

describe('comparePriceToCatalog', () => {
  it('accepts a price that matches the published amount, currency, and cadence', () => {
    expect(comparePriceToCatalog(GARDEN_MONTHLY, priceLike() as Stripe.Price)).toEqual([]);
  });

  it('catches an amount the UI never showed', () => {
    const problems = comparePriceToCatalog(
      GARDEN_MONTHLY,
      priceLike({ unit_amount: 999 }) as Stripe.Price
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('999 cents');
    expect(problems[0]).toContain('499 cents');
    expect(problems[0]).toContain('STRIPE_PRICE_ID_GARDEN');
  });

  it('catches a foreign currency even when the digits match', () => {
    const problems = comparePriceToCatalog(
      GARDEN_MONTHLY,
      priceLike({ currency: 'eur' }) as Stripe.Price
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('eur');
    expect(problems[0]).toContain(CATALOG_CURRENCY.toUpperCase());
  });

  it('catches a monthly plan wired to an annual price (the transposed-id case)', () => {
    const problems = comparePriceToCatalog(
      GARDEN_MONTHLY,
      priceLike({
        unit_amount: 3999,
        recurring: { interval: 'year', interval_count: 1 } as Stripe.Price.Recurring,
      }) as Stripe.Price
    );
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('recurs every "year"');
  });

  it('catches an interval_count that quietly changes the cadence', () => {
    const problems = comparePriceToCatalog(
      GARDEN_MONTHLY,
      priceLike({
        recurring: { interval: 'month', interval_count: 3 } as Stripe.Price.Recurring,
      }) as Stripe.Price
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('every 3 month');
  });

  it('catches a one-time price standing in for a subscription', () => {
    const problems = comparePriceToCatalog(
      GARDEN_MONTHLY,
      priceLike({ recurring: null }) as Stripe.Price
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('one-time price');
  });

  it('catches a RECURRING price standing in for the one-time lifetime tier', () => {
    // The expensive direction: a household pays $149 expecting it once and is
    // billed $149 forever.
    const lifetime = expectedPriceFor('garden', 'lifetime') as ExpectedPrice;
    const problems = comparePriceToCatalog(
      lifetime,
      priceLike({
        unit_amount: 14900,
        recurring: { interval: 'month', interval_count: 1 } as Stripe.Price.Recurring,
      }) as Stripe.Price
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('one-time charge');
  });

  it('accepts a correct lifetime price (one-time, no recurring block)', () => {
    const lifetime = expectedPriceFor('garden', 'lifetime') as ExpectedPrice;
    expect(
      comparePriceToCatalog(
        lifetime,
        priceLike({ unit_amount: 14900, recurring: null }) as Stripe.Price
      )
    ).toEqual([]);
  });

  it('catches an archived price, which Stripe refuses to sell', () => {
    const problems = comparePriceToCatalog(
      GARDEN_MONTHLY,
      priceLike({ active: false }) as Stripe.Price
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('archived');
  });

  it('never echoes the configured price id, only the env var that holds it', () => {
    const problems = comparePriceToCatalog(
      GARDEN_MONTHLY,
      priceLike({ id: 'price_secret_looking_value', unit_amount: 1 }) as Stripe.Price
    );
    expect(problems.join(' ')).not.toContain('price_secret_looking_value');
    expect(problems.join(' ')).toContain('STRIPE_PRICE_ID_GARDEN');
  });
});

describe('reconcilePrice — fails closed', () => {
  it('reports ok for a matching price', async () => {
    const { stripe } = fakeStripe({ price_ok: priceLike() });
    await expect(reconcilePrice(stripe, GARDEN_MONTHLY, 'price_ok')).resolves.toMatchObject({
      status: 'ok',
      problems: [],
    });
  });

  it('treats an unretrievable price as a FAILURE, never as "probably fine"', async () => {
    const { stripe } = fakeStripe({ price_boom: new Error('Stripe API unreachable') });
    const result = await reconcilePrice(stripe, GARDEN_MONTHLY, 'price_boom');
    expect(result.status).toBe('unretrievable');
    expect(result.problems[0]).toContain('could not be retrieved');
    expect(result.problems[0]).toContain('Stripe API unreachable');
  });

  it('treats a deleted/unknown price id as a FAILURE', async () => {
    const { stripe } = fakeStripe({});
    await expect(reconcilePrice(stripe, GARDEN_MONTHLY, 'price_gone')).resolves.toMatchObject({
      status: 'unretrievable',
    });
  });
});

describe('reconcileConfiguredPrices', () => {
  it('sweeps every configured cadence and names the mismatched one', async () => {
    const { stripe, retrieve } = fakeStripe({
      p_garden_m: priceLike(),
      // Transposed: the annual slot points at a monthly-shaped price.
      p_garden_y: priceLike({ unit_amount: 499 }),
      p_garden_l: priceLike({ unit_amount: 14900, recurring: null }),
      p_gh_m: priceLike({ unit_amount: 999 }),
      p_gh_y: priceLike({
        unit_amount: 7999,
        recurring: { interval: 'year', interval_count: 1 } as Stripe.Price.Recurring,
      }),
    });
    const results = await reconcileConfiguredPrices(stripe, {
      STRIPE_PRICE_ID_GARDEN: 'p_garden_m',
      STRIPE_PRICE_ID_GARDEN_ANNUAL: 'p_garden_y',
      STRIPE_PRICE_ID_GARDEN_LIFETIME: 'p_garden_l',
      STRIPE_PRICE_ID_GREENHOUSE: 'p_gh_m',
      STRIPE_PRICE_ID_GREENHOUSE_ANNUAL: 'p_gh_y',
    });

    expect(retrieve).toHaveBeenCalledTimes(5);
    const byEnv = Object.fromEntries(results.map((r) => [r.env, r.status]));
    expect(byEnv).toEqual({
      STRIPE_PRICE_ID_GARDEN: 'ok',
      STRIPE_PRICE_ID_GARDEN_ANNUAL: 'mismatch',
      STRIPE_PRICE_ID_GARDEN_LIFETIME: 'ok',
      STRIPE_PRICE_ID_GREENHOUSE: 'ok',
      STRIPE_PRICE_ID_GREENHOUSE_ANNUAL: 'ok',
    });
  });

  it('reports an unset price id as unconfigured, not as a mismatch', async () => {
    // The repository's committed state under the paid-activity hold: every
    // production price id is blank on purpose (docs/billing.md).
    const { stripe, retrieve } = fakeStripe({});
    const results = await reconcileConfiguredPrices(stripe, {});
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 'unconfigured')).toBe(true);
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe('assertPriceMatchesCatalog', () => {
  it('resolves silently when Stripe agrees with the catalog', async () => {
    const { stripe } = fakeStripe({ price_ok: priceLike() });
    await expect(
      assertPriceMatchesCatalog(stripe, 'garden', 'month', 'price_ok')
    ).resolves.toBeUndefined();
  });

  it('throws a typed error when the amount differs', async () => {
    const { stripe } = fakeStripe({ price_wrong: priceLike({ unit_amount: 100_000 }) });
    const err = await assertPriceMatchesCatalog(stripe, 'garden', 'month', 'price_wrong').catch(
      (e: unknown) => e
    );
    expect(isPriceReconciliationError(err)).toBe(true);
    expect((err as PriceReconciliationError).reconciliation.status).toBe('mismatch');
  });

  it('throws when the price cannot be retrieved at all', async () => {
    const { stripe } = fakeStripe({ price_down: new Error('network down') });
    const err = await assertPriceMatchesCatalog(stripe, 'garden', 'month', 'price_down').catch(
      (e: unknown) => e
    );
    expect(isPriceReconciliationError(err)).toBe(true);
    expect((err as PriceReconciliationError).reconciliation.status).toBe('unretrievable');
  });

  it('throws for a (plan, cadence) pair the catalog does not sell', async () => {
    const { stripe, retrieve } = fakeStripe({ anything: priceLike() });
    await expect(
      assertPriceMatchesCatalog(stripe, 'greenhouse', 'lifetime', 'anything')
    ).rejects.toThrow(/publishes no lifetime amount/);
    expect(retrieve).not.toHaveBeenCalled();
  });
});
