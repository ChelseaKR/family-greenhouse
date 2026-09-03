/**
 * Stripe Checkout for an identification top-up pack.
 *
 * Mechanically the withdrawn lifetime purchase (`mode: 'payment'`, no
 * subscription_data, no trial) with two differences that matter:
 *
 *   1. It grants CREDITS, not entitlement. The webhook never touches the
 *      household's plan, subscription, or the METADATA row at all; it writes
 *      a pack row (`identifyCredits.grantCreditPack`) keyed by this session.
 *   2. It fails closed on configuration. The price id comes from ONE env var
 *      with no fallback; unset means the pack is not for sale here and the
 *      caller gets a clear, client-correctable refusal before Stripe or
 *      DynamoDB is touched — never a substitute price, never a free grant.
 *
 * Lives beside `billing.ts` rather than inside it so the subscription
 * path's hunk stays small; it borrows the Stripe client and the household
 * customer lookup from there.
 */
import type Stripe from 'stripe';
import { assertPaymentActivityAllowed } from '../config/commercialStatus.js';
import {
  IDENTIFY_TOP_UP_PACK,
  IDENTIFY_TOP_UP_PURCHASE_KIND,
  identifyTopUpPriceId,
} from '../models/identifyTopUp.js';
import { getHouseholdSubscription, getStripe } from './billing.js';

export interface IdentifyTopUpCheckoutArgs {
  householdId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  /** Stable per click; Stripe returns the same Session on a safe retry. */
  idempotencyKey?: string;
}

/**
 * Error prefixes the handler maps to client-correctable statuses. Same
 * convention as `INTERVAL_WITHDRAWN` / `ALREADY_SUBSCRIBED` in billing.ts.
 */
export const TOP_UP_NOT_CONFIGURED = 'TOP_UP_NOT_CONFIGURED';

export async function createIdentifyTopUpCheckoutSession(
  args: IdentifyTopUpCheckoutArgs
): Promise<{ url: string }> {
  // Same gate as every other payment surface: refuse before configuration,
  // DynamoDB, or Stripe.
  assertPaymentActivityAllowed();
  const priceId = identifyTopUpPriceId();
  if (!priceId) {
    throw new Error(
      `${TOP_UP_NOT_CONFIGURED}: ${IDENTIFY_TOP_UP_PACK.stripePriceEnv} is not set; the identification top-up pack is not for sale in this environment.`
    );
  }
  // Reuse the household's Stripe customer when one exists so the purchase
  // lands on the same invoice history as its subscription. A household that
  // has never subscribed checks out by email; Stripe emails the receipt.
  const sub = await getHouseholdSubscription(args.householdId);
  const stripe = await getStripe();
  // `purchase` is the positive marker the webhook branches on; `credits` is
  // what the grant reads, so a later change to the pack size cannot re-price
  // a session already paid for. `interval` is deliberately absent — this is
  // not a plan cadence and must never be read as one.
  const metadata: Record<string, string> = {
    householdId: args.householdId,
    purchase: IDENTIFY_TOP_UP_PURCHASE_KIND,
    packId: IDENTIFY_TOP_UP_PACK.id,
    credits: String(IDENTIFY_TOP_UP_PACK.credits),
  };
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    customer: sub.stripeCustomerId,
    customer_email: sub.stripeCustomerId ? undefined : args.customerEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.householdId,
    metadata,
    automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX_ENABLED === '1' },
    customer_update: sub.stripeCustomerId
      ? ({ address: 'auto', name: 'auto' } as const)
      : undefined,
  };
  const session = args.idempotencyKey
    ? await stripe.checkout.sessions.create(params, { idempotencyKey: args.idempotencyKey })
    : await stripe.checkout.sessions.create(params);
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url };
}
