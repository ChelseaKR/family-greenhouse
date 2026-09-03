/**
 * Identification top-up pack — consumption priced, not subsidized.
 *
 * Every Plant.id identification costs a real, per-call vendor price
 * ($0.0585 at our tier; `docs/adr/0012-*`), and it is the one bundled
 * entitlement that decides whether a tier makes or loses money. This pack
 * sells identifications ON TOP of a plan's monthly allowance, one-time, so
 * a household that identifies a lot pays for what it uses instead of the
 * tier absorbing it. See `docs/adr/0019-identification-top-up-packs.md`
 * for the price, the margin, and why this is a pack and not a higher cap.
 *
 * Deliberately NOT a plan and NOT an interval on a plan: it grants no
 * entitlement, changes no cap, and touches no subscription. It is a durable
 * household credit balance (`services/identifyCredits.ts`) that the identify
 * guard draws on only after the plan allowance is spent
 * (`services/identifyBudget.ts#reserveIdentification`).
 *
 * Pure module: no DynamoDB, no Stripe client. The dev mock server and the
 * webhook both import it.
 */
import type Stripe from 'stripe';

export const IDENTIFY_TOP_UP_PACK = {
  /** Stable identifier stamped on Stripe metadata; never shown to users. */
  id: 'identify-20',
  /** Identifications one pack grants. */
  credits: 20,
  /** Headline price in dollars. The Stripe price object must match. */
  priceUsd: 1.99,
  /** Credits expire this many days after purchase — never auto-renewed. */
  validityDays: 365,
  /** Env var carrying the Stripe one-time price id. Unset = not for sale. */
  stripePriceEnv: 'STRIPE_PRICE_ID_IDENTIFY_TOP_UP',
} as const;

/**
 * Metadata marker stamped on the Checkout Session at creation. Both the
 * withdrawn lifetime purchase and a top-up are `mode: 'payment'`, so the
 * webhook needs a positive signal to tell them apart — the absence of a
 * `planId` is not enough (a malformed lifetime event also lacks one, and
 * that path logs an error and grants nothing).
 */
export const IDENTIFY_TOP_UP_PURCHASE_KIND = 'identify_top_up';

/**
 * The configured Stripe price id, or undefined when the env var is unset or
 * blank. There is deliberately no fallback: an unset price means the pack
 * is not for sale in this environment, and checkout must refuse — never
 * substitute another price, never grant credits for free.
 */
export function identifyTopUpPriceId(): string | undefined {
  const raw = process.env[IDENTIFY_TOP_UP_PACK.stripePriceEnv];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function isIdentifyTopUpConfigured(): boolean {
  return identifyTopUpPriceId() !== undefined;
}

export interface IdentifyTopUpSummary {
  /** True only when payments are on AND a Stripe price is configured. */
  available: boolean;
  credits: number;
  validityDays: number;
  /** Present only when payment activity is enabled (same fail-closed rule
   *  as `planSummary`): a paused environment publishes no amounts. */
  priceUsd?: number;
}

/**
 * Client-facing projection of the offer. Mirrors `planSummary`'s contract:
 * amounts appear only once the caller has proved payments are available.
 */
export function identifyTopUpSummary(paymentsAvailable: boolean): IdentifyTopUpSummary {
  const summary: IdentifyTopUpSummary = {
    available: paymentsAvailable && isIdentifyTopUpConfigured(),
    credits: IDENTIFY_TOP_UP_PACK.credits,
    validityDays: IDENTIFY_TOP_UP_PACK.validityDays,
  };
  if (paymentsAvailable) summary.priceUsd = IDENTIFY_TOP_UP_PACK.priceUsd;
  return summary;
}

/** True when a Checkout Session was minted by `createIdentifyTopUpCheckoutSession`. */
export function isIdentifyTopUpSession(session: {
  metadata?: Record<string, string> | null;
}): boolean {
  return session.metadata?.purchase === IDENTIFY_TOP_UP_PURCHASE_KIND;
}

export interface IdentifyTopUpGrant {
  householdId: string;
  /** Stripe Checkout Session id — the idempotency key of the grant. */
  stripeSessionId: string;
  credits: number;
  /** ISO timestamp the payment completed; validity counts from here. */
  purchasedAt: string;
}

/**
 * The credit grant a Stripe event describes, or null for anything else.
 *
 * Only a PAID top-up checkout grants. `checkout.session.completed` arrives
 * with `payment_status: 'unpaid'` for deferred payment methods; the later
 * `checkout.session.async_payment_succeeded` carries the same session and
 * grants then. Credits are read from the metadata stamped at checkout so the
 * webhook grants what was sold at the time, and refused when that number is
 * missing or nonsensical — the alternative is inventing a grant off an
 * event we did not mint.
 */
export function identifyTopUpGrantFromEvent(event: Stripe.Event): IdentifyTopUpGrant | null {
  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'checkout.session.async_payment_succeeded'
  ) {
    return null;
  }
  const session = event.data.object as unknown as {
    id?: string;
    mode?: string;
    payment_status?: string;
    metadata?: Record<string, string> | null;
    client_reference_id?: string | null;
  };
  if (!isIdentifyTopUpSession(session)) return null;
  if (session.mode !== 'payment' || session.payment_status !== 'paid') return null;
  if (typeof session.id !== 'string' || session.id === '') return null;
  const householdId = session.metadata?.householdId ?? session.client_reference_id ?? '';
  if (!householdId) return null;
  const credits = Number(session.metadata?.credits);
  if (!Number.isInteger(credits) || credits <= 0 || credits > 1000) return null;
  return {
    householdId,
    stripeSessionId: session.id,
    credits,
    purchasedAt: new Date(event.created * 1000).toISOString(),
  };
}
