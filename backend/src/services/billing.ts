// Type-only import: erased at compile time. The runtime Stripe SDK is
// dynamically imported inside getStripe() so handlers that merely import
// billing.ts for getHouseholdSubscription (plants, api-keys, households…)
// don't pay Stripe's module-evaluation cost on every cold start.
import type Stripe from 'stripe';
import { UpdateCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { Plan, PlanId, getPlan, isPlanId, PLANS } from '../models/plans.js';
import { audit } from '../utils/auditLog.js';

let cachedClient: Stripe | null = null;

/**
 * Lazy Stripe client. Tests don't need a real key (we don't reach the network
 * in unit tests), and the dev local-server doesn't require Stripe at all.
 * Async because the SDK itself is loaded on first use (cold-start hygiene).
 */
export async function getStripe(): Promise<Stripe> {
  if (cachedClient) return cachedClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is required for billing operations');
  const { default: StripeCtor } = await import('stripe');
  cachedClient = new StripeCtor(key);
  return cachedClient;
}

export interface HouseholdSubscription {
  planId: PlanId;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  status?: string;
  currentPeriodEnd?: string;
}

export async function getHouseholdSubscription(
  householdId: string
): Promise<HouseholdSubscription> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
    })
  );
  const item = result.Item;
  if (!item) return { planId: 'seedling' };
  return {
    planId: (item.planId as PlanId) ?? 'seedling',
    stripeCustomerId: item.stripeCustomerId as string | undefined,
    stripeSubscriptionId: item.stripeSubscriptionId as string | undefined,
    status: item.subscriptionStatus as string | undefined,
    currentPeriodEnd: item.subscriptionCurrentPeriodEnd as string | undefined,
  };
}

/**
 * Write subscription fields onto the household metadata row.
 *
 * When `stripeEventCreated` (the Stripe event's `created` unix timestamp) is
 * supplied, the write is conditioned on it being >= the last applied event's
 * timestamp, and the timestamp is stored alongside the fields. That guards
 * against out-of-order webhook delivery: a delayed/retried stale `updated`
 * can no longer clobber a newer `deleted` (or vice versa).
 *
 * Returns `true` when the write was applied, `false` when it was skipped as
 * out-of-order.
 */
export async function updateHouseholdSubscription(
  householdId: string,
  fields: Partial<HouseholdSubscription>,
  stripeEventCreated?: number
): Promise<boolean> {
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const map: Record<keyof HouseholdSubscription, string> = {
    planId: 'planId',
    stripeCustomerId: 'stripeCustomerId',
    stripeSubscriptionId: 'stripeSubscriptionId',
    status: 'subscriptionStatus',
    currentPeriodEnd: 'subscriptionCurrentPeriodEnd',
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const attr = map[key as keyof HouseholdSubscription];
    expressions.push(`#${attr} = :${attr}`);
    names[`#${attr}`] = attr;
    values[`:${attr}`] = value;
  }
  if (expressions.length === 0) return true;

  let conditionExpression: string | undefined;
  if (typeof stripeEventCreated === 'number') {
    expressions.push('#lastStripeEventCreated = :lastStripeEventCreated');
    names['#lastStripeEventCreated'] = 'lastStripeEventCreated';
    values[':lastStripeEventCreated'] = stripeEventCreated;
    // <= (not <) so two events minted in the same second still both apply;
    // Stripe's `created` has 1s resolution.
    conditionExpression =
      'attribute_not_exists(lastStripeEventCreated) OR lastStripeEventCreated <= :lastStripeEventCreated';
  }

  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
        UpdateExpression: `SET ${expressions.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: conditionExpression,
      })
    );
    return true;
  } catch (err) {
    if (
      conditionExpression &&
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      return false;
    }
    throw err;
  }
}

export interface CheckoutSessionResult {
  url: string;
}

export async function createCheckoutSession(args: {
  householdId: string;
  customerEmail: string;
  planId: PlanId;
  successUrl: string;
  cancelUrl: string;
}): Promise<CheckoutSessionResult> {
  const plan = getPlan(args.planId);
  if (!plan.stripePriceEnv) throw new Error(`Plan ${plan.id} is not billable`);
  const priceId = process.env[plan.stripePriceEnv];
  if (!priceId) throw new Error(`Missing ${plan.stripePriceEnv} for plan ${plan.id}`);

  const sub = await getHouseholdSubscription(args.householdId);
  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: sub.stripeCustomerId,
    customer_email: sub.stripeCustomerId ? undefined : args.customerEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.householdId,
    metadata: { householdId: args.householdId, planId: plan.id },
    subscription_data: {
      metadata: { householdId: args.householdId, planId: plan.id },
      trial_period_days: 14,
    },
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url };
}

export async function createPortalSession(
  householdId: string,
  returnUrl: string
): Promise<{ url: string }> {
  const sub = await getHouseholdSubscription(householdId);
  if (!sub.stripeCustomerId) {
    throw new Error('No Stripe customer on file for this household');
  }
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

/**
 * Resolve a Stripe webhook event into a household subscription update. Pure
 * function — `applySubscriptionEvent` does the DDB write — so the webhook
 * handler can mock this in tests easily.
 */
export interface SubscriptionDelta {
  householdId: string;
  fields: Partial<HouseholdSubscription>;
}

/**
 * Resolve the planId from event metadata. We stamp `planId` onto both the
 * checkout session and the subscription at creation time, so a missing or
 * unknown value means the event wasn't minted by us (or our metadata
 * contract broke). NEVER default to a paid plan — that would grant paid
 * entitlements off a malformed event. Log loudly and skip instead.
 */
function planIdFromMetadata(
  event: Stripe.Event,
  metadata: Record<string, string> | null | undefined
): PlanId | null {
  const raw = metadata?.planId;
  if (isPlanId(raw)) return raw;
  logger.error(
    { stripeEventId: event.id, type: event.type, planId: raw ?? null },
    'stripe_event_missing_or_unknown_plan_id'
  );
  return null;
}

export function deltaForStripeEvent(event: Stripe.Event): SubscriptionDelta | null {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const householdId = session.metadata?.householdId ?? session.client_reference_id ?? '';
      if (!householdId) return null;
      const planId = planIdFromMetadata(event, session.metadata);
      if (!planId) return null;
      return {
        householdId,
        fields: {
          planId,
          stripeCustomerId:
            typeof session.customer === 'string' ? session.customer : session.customer?.id,
          stripeSubscriptionId:
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id,
          status: 'active',
        },
      };
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const sub = event.data.object;
      const householdId = (sub.metadata?.householdId as string | undefined) ?? '';
      if (!householdId) return null;
      const planId = planIdFromMetadata(event, sub.metadata);
      if (!planId) return null;
      // current_period_end moved off the top-level Subscription object in
      // newer Stripe API versions and now lives on the subscription item.
      const periodEnd =
        (sub as unknown as { current_period_end?: number }).current_period_end ??
        sub.items?.data?.[0]?.current_period_end;
      return {
        householdId,
        fields: {
          planId,
          stripeSubscriptionId: sub.id,
          status: sub.status,
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
        },
      };
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const householdId = (sub.metadata?.householdId as string | undefined) ?? '';
      if (!householdId) return null;
      return {
        householdId,
        fields: { planId: 'seedling', status: 'canceled' },
      };
    }
    default:
      return null;
  }
}

/**
 * Record a Stripe event id in the dedupe ledger. Returns `true` the first
 * time an id is seen, `false` on a redelivery.
 *
 * NOTE on ordering: the ledger is written AFTER the subscription update is
 * applied (see applyStripeEvent). Recording first would mean a failed apply
 * is permanently skipped when Stripe retries — the retry would hit the
 * ledger, see "duplicate", and drop the event. Re-applying on a true
 * duplicate is harmless (last-write-wins fields, guarded against
 * out-of-order delivery by `lastStripeEventCreated`), so the ledger is
 * observability/cheap-skip only, not the correctness mechanism.
 * The ledger row carries a 30-day TTL so the table sweeps it automatically.
 */
export async function recordStripeEventOnce(eventId: string): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `STRIPE_EVENT#${eventId}`,
          SK: 'METADATA',
          entityType: 'StripeEvent',
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  const delta = deltaForStripeEvent(event);
  if (!delta) return;

  // Apply FIRST, record SECOND. If the apply throws, we return 5xx to Stripe
  // without having touched the ledger, so Stripe's retry gets a clean run.
  // (The old record-first order permanently skipped an event whose apply
  // failed once.) The `event.created` guard inside the update makes a stale
  // redelivery a no-op rather than a clobber.
  const applied = await updateHouseholdSubscription(delta.householdId, delta.fields, event.created);
  if (!applied) {
    logger.info(
      { stripeEventId: event.id, type: event.type, householdId: delta.householdId },
      'stripe_event_out_of_order_skipped'
    );
    return;
  }

  const isNew = await recordStripeEventOnce(event.id);
  if (!isNew) {
    logger.info({ stripeEventId: event.id, type: event.type }, 'stripe_event_duplicate_reapplied');
  }

  logger.info(
    { householdId: delta.householdId, fields: delta.fields, msg: 'subscription_updated' },
    'subscription_updated'
  );
  audit('billing.subscription_changed', {
    householdId: delta.householdId,
    metadata: { stripeEventType: event.type, fields: delta.fields },
  });
}

export function planSummary(plan: Plan): {
  id: PlanId;
  name: string;
  description: string;
  monthlyPrice: number;
  maxPlants: number;
  maxMembers: number;
} {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    monthlyPrice: plan.monthlyPrice,
    maxPlants: plan.maxPlants,
    maxMembers: plan.maxMembers,
  };
}

export const ALL_PLANS = Object.values(PLANS);
