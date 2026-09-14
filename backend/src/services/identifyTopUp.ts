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
import { isPlantIdentificationConfigured } from './plantIdentification.js';
import { assertIdentifyTopUpPriceMatchesCatalog } from './stripePrices.js';

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
/**
 * The pack is priced and payable, but the identifications it buys cannot be
 * made: `PLANT_ID_API_KEY` is absent from this process. Distinct from
 * `TOP_UP_NOT_CONFIGURED` because the fix is different (the vendor key, not
 * the Stripe price) and because the client copy must say which promise
 * cannot be kept. A pack sold in this state is a real charge for credits
 * `POST /plants/identify` would never draw on — it answers "not configured"
 * and consumes nothing.
 */
export const IDENTIFICATION_NOT_CONFIGURED = 'IDENTIFICATION_NOT_CONFIGURED';

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
  // Credits nobody can spend are not for sale. Checked here, in the process
  // that would take the money, on the variable THIS process holds: the
  // Lambda that sells the pack is not the Lambda that identifies plants, and
  // it must be given the key too (infrastructure/modules/api/main.tf, the
  // `billing` entry of handler_integration_environment) or this refuses —
  // which is the correct answer for a process that cannot vouch for it.
  if (!isPlantIdentificationConfigured()) {
    throw new Error(
      `${IDENTIFICATION_NOT_CONFIGURED}: PLANT_ID_API_KEY is not set in this process; identification packs are not for sale where identifications cannot be made.`
    );
  }
  // Reuse the household's Stripe customer when one exists so the purchase
  // lands on the same invoice history as its subscription. A household that
  // has never subscribed checks out by email; Stripe emails the receipt.
  const sub = await getHouseholdSubscription(args.householdId);
  const stripe = await getStripe();
  // Never charge an amount the UI did not publish — the same reconciliation
  // `createCheckoutSession` runs immediately before minting a subscription
  // Session, for the same reason: a `price_…` id encodes neither the amount
  // nor whether it recurs, so a transposed value in tfvars is invisible to
  // every other check we have. It matters more here than there. The webhook
  // grants credits from the `credits` metadata stamped below, NOT from what
  // Stripe charged, so a wrong price id bills whatever it bills and still
  // hands over twenty identifications — the two numbers never meet. Fails
  // closed: a price that cannot be retrieved is a refusal, not an assumption.
  await assertIdentifyTopUpPriceMatchesCatalog(stripe, priceId);
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
