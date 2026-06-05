import Stripe from 'stripe';
import { UpdateCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { Plan, PlanId, getPlan, PLANS } from '../models/plans.js';
import { audit } from '../utils/auditLog.js';

let cachedClient: Stripe | null = null;

/**
 * Lazy Stripe client. Tests don't need a real key (we don't reach the network
 * in unit tests), and the dev local-server doesn't require Stripe at all.
 */
export function getStripe(): Stripe {
  if (cachedClient) return cachedClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is required for billing operations');
  cachedClient = new Stripe(key);
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

export async function updateHouseholdSubscription(
  householdId: string,
  fields: Partial<HouseholdSubscription>
): Promise<void> {
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
  if (expressions.length === 0) return;

  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
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
  const stripe = getStripe();
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
  const stripe = getStripe();
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

export function deltaForStripeEvent(event: Stripe.Event): SubscriptionDelta | null {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const householdId = session.metadata?.householdId ?? session.client_reference_id ?? '';
      const planId = (session.metadata?.planId as PlanId | undefined) ?? 'garden';
      if (!householdId) return null;
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
      const planId = (sub.metadata?.planId as PlanId | undefined) ?? 'garden';
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
 * Record a Stripe event id exactly once, so a redelivered webhook can't
 * re-apply the same subscription change. Stripe retries webhooks (and may
 * deliver duplicates) and our handler is otherwise last-write-wins, which
 * means a re-delivered stale `created` could clobber a later `deleted`.
 *
 * Returns `true` when this is the first time we've seen the event (caller
 * should proceed), `false` when it was already processed (caller should skip).
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
  const isNew = await recordStripeEventOnce(event.id);
  if (!isNew) {
    logger.info({ stripeEventId: event.id, type: event.type }, 'stripe_event_duplicate_skipped');
    return;
  }
  const delta = deltaForStripeEvent(event);
  if (!delta) return;
  await updateHouseholdSubscription(delta.householdId, delta.fields);
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
