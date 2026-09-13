/**
 * Reconciliation between the price catalog we PUBLISH (`models/plans.ts`, the
 * numbers `planSummary` puts on the pricing page) and the price objects Stripe
 * would actually CHARGE.
 *
 * Why this exists: nothing else compares the two. `stripe_price_ids_are_live`
 * (infrastructure/main.tf) only guards test-mode ids reaching a live key —
 * Stripe price ids encode neither the amount nor the mode, so two transposed
 * `price_…` values in tfvars are invisible to every check we had. A household
 * would see "$4.99/mo" in the UI and be charged whatever the transposed price
 * says, on whatever cadence it recurs. That is money taken for something other
 * than what was shown.
 *
 * Design notes:
 *   - The Stripe client is INJECTED, never constructed here. That keeps this
 *     module free of `billing.ts`'s DynamoDB/Stripe bootstrap (no import
 *     cycle) and lets tests drive the real assertion logic with a fake client
 *     and no credentials.
 *   - Fail closed. A price that cannot be retrieved is `unretrievable`, never
 *     "probably fine": we would rather refuse a checkout than charge an
 *     unverified amount.
 *   - Messages name the ENV VAR, never the price id value. Price ids are not
 *     secret, but an operator reading a log needs to know WHICH slot is wrong,
 *     and echoing configured identifiers into logs is a habit worth not
 *     forming.
 */
import type Stripe from 'stripe';
import { PLANS, type Plan, type PlanId } from '../models/plans.js';
import { IDENTIFY_TOP_UP_PACK } from '../models/identifyTopUp.js';

/**
 * Cadences a catalog price can be sold at. `month`/`year`/`lifetime` mirror
 * `BillingInterval`; `one_time` is for the amounts that are not plan
 * cadences at all (the identification top-up pack), which Stripe reports the
 * same way as `lifetime` — `recurring: null` — but which must not be
 * DESCRIBED as a lifetime tier in an operator-facing message.
 */
export type PriceCadence = 'month' | 'year' | 'lifetime' | 'one_time';

/**
 * Everything this repository charges for. Plan tiers come from `PLANS`; the
 * identification top-up pack is deliberately not a plan (it grants credits,
 * not entitlement — see `models/identifyTopUp.ts`) but it is still a
 * published amount that a Stripe price can silently contradict, so it
 * reconciles through exactly the same comparison as every plan price.
 */
export type CatalogItemId = PlanId | typeof IDENTIFY_TOP_UP_PACK.id;

/**
 * Every published Family Greenhouse amount is in US dollars: `plans.ts`
 * documents its fields as "dollars", docs/billing.md prints them as `$4.99` /
 * `$39.99` / `$149`, and the Terraform variable descriptions repeat the same
 * figures with `$`. A price whose Stripe currency is anything else charges a
 * number the UI never showed, even when the digits happen to match.
 */
export const CATALOG_CURRENCY = 'usd';

/** One catalog amount, expanded into what Stripe should report for it. */
export interface ExpectedPrice {
  itemId: CatalogItemId;
  cadence: PriceCadence;
  /** Env var the price id is read from at runtime. */
  env: string;
  /** Catalog amount in dollars, straight from `models/plans.ts`. */
  dollars: number;
  /** The same amount in cents, which is what Stripe reports as `unit_amount`. */
  unitAmount: number;
}

export type PriceReconciliationStatus = 'ok' | 'mismatch' | 'unretrievable' | 'unconfigured';

export interface PriceReconciliation {
  itemId: CatalogItemId;
  cadence: PriceCadence;
  env: string;
  status: PriceReconciliationStatus;
  /** Human-readable reasons. Empty exactly when `status === 'ok'`. */
  problems: string[];
}

/**
 * Dollars → cents without binary-floating-point drift. `4.99 * 100` is
 * 499.00000000000006 in IEEE 754, which is not equal to Stripe's 499.
 */
export function unitAmountFor(dollars: number): number {
  return Math.round(dollars * 100);
}

/** The catalog amounts a single plan publishes, one row per configured cadence. */
export function expectedPricesForPlan(plan: Plan): ExpectedPrice[] {
  const rows: ExpectedPrice[] = [];
  const push = (cadence: PriceCadence, dollars: number | undefined, env: string | undefined) => {
    if (dollars === undefined || !env) return;
    rows.push({
      itemId: plan.id,
      cadence,
      env,
      dollars,
      unitAmount: unitAmountFor(dollars),
    });
  };
  // The free tier publishes no amount and owns no Stripe price, so it has
  // nothing to reconcile — `stripePriceEnv` is undefined and push() drops it.
  push('month', plan.monthlyPrice, plan.stripePriceEnv);
  push('year', plan.annualPrice, plan.annualStripePriceEnv);
  push('lifetime', plan.lifetimePrice, plan.lifetimeStripePriceEnv);
  return rows;
}

/**
 * The catalog row for the identification top-up pack.
 *
 * Derived from `IDENTIFY_TOP_UP_PACK` rather than restating $1.99, for the
 * same reason the plan rows read through `PLANS`: a change to the published
 * price must move this reconciliation with it, never leave it checking a
 * stale copy. The pack is a single one-time charge, so Stripe must report
 * `recurring: null` — a recurring price in that slot would bill a household
 * $1.99 forever for twenty identifications it bought once.
 */
export function identifyTopUpExpectedPrice(): ExpectedPrice {
  return {
    itemId: IDENTIFY_TOP_UP_PACK.id,
    cadence: 'one_time',
    env: IDENTIFY_TOP_UP_PACK.stripePriceEnv,
    dollars: IDENTIFY_TOP_UP_PACK.priceUsd,
    unitAmount: unitAmountFor(IDENTIFY_TOP_UP_PACK.priceUsd),
  };
}

/**
 * Every catalog amount we charge for: the plan cadences, plus the one-time
 * packs that are not plans. The top-up belongs here and not only on its own
 * assert path — `reconcileConfiguredPrices` is the sweep that answers "is
 * anything configured to charge what we never published", and a row missing
 * from it is a row the sweep silently declares clean.
 */
export function expectedPrices(): ExpectedPrice[] {
  return [...Object.values(PLANS).flatMap(expectedPricesForPlan), identifyTopUpExpectedPrice()];
}

/** The one catalog row for a (plan, cadence) pair, or null if none is sold. */
export function expectedPriceFor(planId: PlanId, cadence: PriceCadence): ExpectedPrice | null {
  return expectedPricesForPlan(PLANS[planId]).find((row) => row.cadence === cadence) ?? null;
}

/**
 * Compare a retrieved Stripe Price against a catalog row. Pure — no I/O — so
 * the comparison itself is exercised directly, with no client at all.
 *
 * `lifetime` is a one-time payment: Stripe reports `recurring: null` for it,
 * and a recurring price standing in for it would bill the household forever
 * for what we sold as a single charge.
 */
export function comparePriceToCatalog(expected: ExpectedPrice, price: Stripe.Price): string[] {
  const problems: string[] = [];

  if (price.unit_amount !== expected.unitAmount) {
    problems.push(
      `${expected.env}: Stripe charges ${String(price.unit_amount)} cents but the catalog publishes ` +
        `${String(expected.unitAmount)} cents ($${expected.dollars.toFixed(2)})`
    );
  }

  if (price.currency !== CATALOG_CURRENCY) {
    problems.push(
      `${expected.env}: Stripe currency is "${String(price.currency)}" but the catalog publishes ` +
        `${CATALOG_CURRENCY.toUpperCase()} amounts`
    );
  }

  if (expected.cadence === 'lifetime' || expected.cadence === 'one_time') {
    if (price.recurring) {
      problems.push(
        `${expected.env}: this is sold as a one-time charge but Stripe reports a recurring ` +
          `price (interval "${String(price.recurring.interval)}")`
      );
    }
  } else if (!price.recurring) {
    problems.push(
      `${expected.env}: the ${expected.cadence}ly tier is a subscription but Stripe reports a ` +
        `one-time price`
    );
  } else if (price.recurring.interval !== expected.cadence) {
    problems.push(
      `${expected.env}: Stripe recurs every "${String(price.recurring.interval)}" but the catalog ` +
        `sells this as "${expected.cadence}"`
    );
  } else if (price.recurring.interval_count !== 1) {
    // A price that bills every 3 months at the monthly amount charges a
    // third of what the published "per month" figure implies.
    problems.push(
      `${expected.env}: Stripe bills every ${String(price.recurring.interval_count)} ` +
        `${expected.cadence}s but the catalog publishes a single-${expected.cadence} cadence`
    );
  }

  // An archived price still resolves and still has an amount, but Stripe
  // refuses to create a Checkout Session against it. Surfacing it here turns a
  // confusing checkout-time 400 into a named configuration problem.
  if (price.active === false) {
    problems.push(
      `${expected.env}: the Stripe price is archived (active=false) and cannot be sold`
    );
  }

  return problems;
}

/**
 * Retrieve one price and reconcile it. Fails closed: any retrieval error is
 * `unretrievable`, which callers must treat as "do not charge".
 */
export async function reconcilePrice(
  stripe: Pick<Stripe, 'prices'>,
  expected: ExpectedPrice,
  priceId: string
): Promise<PriceReconciliation> {
  let price: Stripe.Price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (err) {
    return {
      itemId: expected.itemId,
      cadence: expected.cadence,
      env: expected.env,
      status: 'unretrievable',
      problems: [
        `${expected.env}: the configured Stripe price could not be retrieved (${
          err instanceof Error ? err.message : 'unknown error'
        })`,
      ],
    };
  }

  const problems = comparePriceToCatalog(expected, price);
  return {
    itemId: expected.itemId,
    cadence: expected.cadence,
    env: expected.env,
    status: problems.length === 0 ? 'ok' : 'mismatch',
    problems,
  };
}

/**
 * Sweep every catalog amount against its configured Stripe price.
 *
 * An UNSET price id is `unconfigured`, not a failure: docs/billing.md states
 * that empty values keep Stripe inert on purpose ("an empty MONTHLY id makes a
 * plan unbuyable"), which is the repository's current committed state under
 * the paid-activity hold. `createCheckoutSession` refuses an unconfigured
 * cadence before it reaches Stripe, so nothing can be sold at a price this
 * sweep never saw.
 */
export async function reconcileConfiguredPrices(
  stripe: Pick<Stripe, 'prices'>,
  env: NodeJS.ProcessEnv = process.env
): Promise<PriceReconciliation[]> {
  const results: PriceReconciliation[] = [];
  for (const expected of expectedPrices()) {
    const priceId = env[expected.env];
    if (!priceId) {
      results.push({
        itemId: expected.itemId,
        cadence: expected.cadence,
        env: expected.env,
        status: 'unconfigured',
        problems: [`${expected.env} is not set, so this cadence is not for sale`],
      });
      continue;
    }
    results.push(await reconcilePrice(stripe, expected, priceId));
  }
  return results;
}

/** Thrown when a price we are about to charge does not match the catalog. */
export class PriceReconciliationError extends Error {
  readonly code = 'PRICE_RECONCILIATION_FAILED';
  readonly reconciliation: PriceReconciliation;

  constructor(reconciliation: PriceReconciliation) {
    super(
      `Stripe price does not match the published catalog: ${reconciliation.problems.join('; ')}`
    );
    this.name = 'PriceReconciliationError';
    this.reconciliation = reconciliation;
  }
}

export function isPriceReconciliationError(error: unknown): error is PriceReconciliationError {
  return (
    error instanceof PriceReconciliationError ||
    (error instanceof Error &&
      (error as Error & { code?: string }).code === 'PRICE_RECONCILIATION_FAILED')
  );
}

/**
 * Gate a single charge on its price matching the catalog. Throws unless Stripe
 * reports exactly the amount, currency, and cadence the UI published.
 *
 * Called immediately before a Checkout Session is created, which is the only
 * moment where the difference between "configured" and "correct" turns into a
 * charge. `unconfigured` cannot reach here — the caller resolves the price id
 * first and refuses an empty one.
 */
export async function assertPriceMatchesCatalog(
  stripe: Pick<Stripe, 'prices'>,
  planId: PlanId,
  cadence: PriceCadence,
  priceId: string
): Promise<void> {
  const expected = expectedPriceFor(planId, cadence);
  if (!expected) {
    throw new PriceReconciliationError({
      itemId: planId,
      cadence,
      env: '(none)',
      status: 'mismatch',
      problems: [`plan ${planId} publishes no ${cadence} amount, so nothing can be charged for it`],
    });
  }
  const result = await reconcilePrice(stripe, expected, priceId);
  if (result.status !== 'ok') throw new PriceReconciliationError(result);
}

/**
 * The same gate for the identification top-up pack.
 *
 * Separate from `assertPriceMatchesCatalog` only because the pack has no
 * `PlanId` and no cadence to look up — the comparison, the fail-closed
 * posture, and the thrown error are identical. It matters MORE here than on
 * the subscription path, not less: the webhook grants credits from the
 * metadata stamped at checkout, so a wrong price id charges whatever that
 * price says and still hands over twenty identifications, with nothing
 * anywhere comparing the two numbers.
 */
export async function assertIdentifyTopUpPriceMatchesCatalog(
  stripe: Pick<Stripe, 'prices'>,
  priceId: string
): Promise<void> {
  const result = await reconcilePrice(stripe, identifyTopUpExpectedPrice(), priceId);
  if (result.status !== 'ok') throw new PriceReconciliationError(result);
}
