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
import {
  GIFTABLE_PLAN_IDS,
  GIFT_PRICE_ENV,
  type GiftablePlanId,
} from '../models/giftSubscriptions.js';

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
export type CatalogItemId = PlanId | typeof IDENTIFY_TOP_UP_PACK.id | GiftCatalogItemId;

/** A gift month of a tier: `gift-garden-month`, `gift-greenhouse-month`. */
export type GiftCatalogItemId = `gift-${GiftablePlanId}-month`;

/**
 * Every published Family Greenhouse amount is in US dollars: `plans.ts`
 * documents its fields as "dollars", docs/billing.md prints them as `$4.99` /
 * `$39.99` / `$149`, and the Terraform variable descriptions repeat the same
 * figures with `$`. A price whose Stripe currency is anything else charges a
 * number the UI never showed, even when the digits happen to match.
 */
export const CATALOG_CURRENCY = 'usd';

/**
 * The Stripe Tax product tax code every catalog item must carry once
 * automatic tax is on: "Software as a service (SaaS) - personal use".
 *
 * Why one code for everything: Garden and Greenhouse are prewritten software
 * reached through a browser, which is the definition; an identification pack
 * is the right to twenty more uses of that same software, not a gift card
 * (Stripe's gift-card code is for a card "assumed to be multi-purpose") and
 * not a service of human effort; a gift month is prepaid months of the same
 * tier. Stripe has no code for prepaid usage credits, and the general code
 * the account presets (`txcd_10000000`, "General - Electronically Supplied
 * Services") is one Stripe itself says to replace with "more specific
 * categories like software ... especially if you sell in the US". From
 * 2027-01-01 California taxes remotely accessed software (SB 122), so the
 * code on the Product decides whether a Californian is charged the right tax.
 *
 * Products are created by hand in the Stripe Dashboard, not by Terraform, so
 * this file cannot SET the code; what it can do is refuse to sell under the
 * wrong one. `comparePriceToCatalog` ignores it while
 * `STRIPE_AUTOMATIC_TAX_ENABLED` is off — today's products carry the preset
 * and nothing is taxed — and demands it the moment the flag is "1", so a
 * product the owner forgot refuses checkout instead of being taxed as the
 * wrong kind of thing, silently, on every sale.
 */
export const CATALOG_TAX_CODE = 'txcd_10103000';

/**
 * The one definition of "Stripe Tax is on" for this process. The three
 * Checkout paths pass it to Stripe as `automatic_tax.enabled`, and the price
 * reconciliation reads the same answer to decide whether the product's tax
 * code is part of what must match. Exactly the string "1", like the other
 * runtime gates (`payments_enabled`), so a stray "true" keeps tax off.
 */
export function automaticTaxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STRIPE_AUTOMATIC_TAX_ENABLED === '1';
}

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
  /**
   * True for a price the tier WAS sold at and no longer sells (ADR 0042).
   * Reconciled at its own amount — a transposed id in a legacy slot would
   * make the webhook map renewals to the wrong tier — but never offered, so
   * `expectedPriceFor` (the checkout gate) skips it.
   */
  legacy?: true;
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
 * The prices a plan USED to be sold at (ADR 0042), one row each, flagged
 * `legacy`. They are reconciled by the sweep like every other configured
 * price — the $4.99 Garden slot must hold a $4.99 monthly recurring price,
 * or renewals on it are being mapped from the wrong object — but they are
 * not in `expectedPricesForPlan`, so nothing can sell at them.
 */
export function legacyPricesForPlan(plan: Plan): ExpectedPrice[] {
  return (plan.legacyPrices ?? []).map((legacy) => ({
    itemId: plan.id,
    cadence: legacy.cadence,
    env: legacy.env,
    dollars: legacy.dollars,
    unitAmount: unitAmountFor(legacy.dollars),
    legacy: true,
  }));
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
/**
 * The catalog row for ONE gift month of a tier (ADR 0028). Its amount is the
 * tier's `monthlyPrice` — read through `PLANS`, never restated — because a
 * gift is priced at the monthly rate times the months, with no discount. A
 * checkout charges this price with `quantity: months`, so a Stripe price
 * that recurs, or that carries any other amount, would bill the buyer
 * something the UI never showed.
 */
export function giftExpectedPrice(planId: GiftablePlanId): ExpectedPrice {
  const dollars = PLANS[planId].monthlyPrice;
  return {
    itemId: `gift-${planId}-month`,
    cadence: 'one_time',
    env: GIFT_PRICE_ENV[planId],
    dollars,
    unitAmount: unitAmountFor(dollars),
  };
}

export function expectedPrices(): ExpectedPrice[] {
  return [
    ...Object.values(PLANS).flatMap(expectedPricesForPlan),
    ...Object.values(PLANS).flatMap(legacyPricesForPlan),
    identifyTopUpExpectedPrice(),
    ...GIFTABLE_PLAN_IDS.map(giftExpectedPrice),
  ];
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
 * Compare the tax code on a price's PRODUCT against `CATALOG_TAX_CODE`. Pure,
 * like `comparePriceToCatalog`, and only ever consulted when automatic tax is
 * on — see `reconcilePrice`.
 *
 * The product must arrive expanded (`reconcilePrice` asks Stripe for it); a
 * bare product id means the code could not be read, and a code that cannot
 * be read is a refusal, not an assumption. A product with NO tax code is
 * named as such rather than passed: Stripe would quietly tax it under the
 * account's preset code, which is exactly the absence this check exists to
 * surface.
 */
export function compareTaxCodeToCatalog(expected: ExpectedPrice, price: Stripe.Price): string[] {
  const product = price.product;
  if (typeof product !== 'object' || product === null) {
    return [
      `${expected.env}: the product behind this price was not returned, so its tax code ` +
        `cannot be checked and it cannot be sold with automatic tax on`,
    ];
  }
  if ('deleted' in product && product.deleted) {
    return [`${expected.env}: the product behind this price has been deleted in Stripe`];
  }
  const raw = product.tax_code;
  const taxCode = typeof raw === 'string' ? raw : raw?.id;
  if (!taxCode) {
    return [
      `${expected.env}: product ${product.id} carries no tax code, so Stripe would tax it under ` +
        `the account preset; set ${CATALOG_TAX_CODE} (Software as a service, personal use) on it`,
    ];
  }
  if (taxCode !== CATALOG_TAX_CODE) {
    return [
      `${expected.env}: product ${product.id} carries tax code ${taxCode} but the catalog is ` +
        `sold as ${CATALOG_TAX_CODE} (Software as a service, personal use)`,
    ];
  }
  return [];
}

/** What `reconcilePrice` must hold a price to, beyond amount and cadence. */
export interface ReconcileOptions {
  /**
   * When true, the product's tax code is part of the comparison. Callers
   * pass `automaticTaxEnabled()`; the sweep passes it from the env it was
   * handed, so a test can ask either question without touching process.env.
   */
  automaticTax?: boolean;
}

/**
 * Retrieve one price and reconcile it. Fails closed: any retrieval error is
 * `unretrievable`, which callers must treat as "do not charge".
 *
 * The product is expanded on every retrieve, not only when automatic tax is
 * on: it is the same single request either way, and it keeps the shape of
 * what Stripe returns constant across the flag, so flipping the flag changes
 * what is DEMANDED of the response, never what is asked for.
 */
export async function reconcilePrice(
  stripe: Pick<Stripe, 'prices'>,
  expected: ExpectedPrice,
  priceId: string,
  options: ReconcileOptions = {}
): Promise<PriceReconciliation> {
  let price: Stripe.Price;
  try {
    price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
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
  if (options.automaticTax) problems.push(...compareTaxCodeToCatalog(expected, price));
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
    results.push(
      await reconcilePrice(stripe, expected, priceId, { automaticTax: automaticTaxEnabled(env) })
    );
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
  const result = await reconcilePrice(stripe, expected, priceId, {
    automaticTax: automaticTaxEnabled(),
  });
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
  const result = await reconcilePrice(stripe, identifyTopUpExpectedPrice(), priceId, {
    automaticTax: automaticTaxEnabled(),
  });
  if (result.status !== 'ok') throw new PriceReconciliationError(result);
}

/**
 * The same gate for a gift month (ADR 0028). The webhook grants `months`
 * from checkout metadata, not from the amount charged, so this is the only
 * place the two numbers meet — exactly the top-up's situation.
 */
export async function assertGiftPriceMatchesCatalog(
  stripe: Pick<Stripe, 'prices'>,
  planId: GiftablePlanId,
  priceId: string
): Promise<void> {
  const result = await reconcilePrice(stripe, giftExpectedPrice(planId), priceId, {
    automaticTax: automaticTaxEnabled(),
  });
  if (result.status !== 'ok') throw new PriceReconciliationError(result);
}
