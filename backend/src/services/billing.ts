// Type-only import: erased at compile time. The runtime Stripe SDK is
// dynamically imported inside getStripe() so handlers that merely import
// billing.ts for getHouseholdSubscription (plants, api-keys, households…)
// don't pay Stripe's module-evaluation cost on every cold start.
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { UpdateCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { PlanId, getPlan, isPlanId, PLANS } from '../models/plans.js';
import { audit } from '../utils/auditLog.js';
import { capture } from '../utils/serverAnalytics.js';
import { assertPaymentActivityAllowed } from '../config/commercialStatus.js';

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

interface HouseholdBillingState extends HouseholdSubscription {
  /** Internal retry marker; never exposed by GET /billing/me. */
  pendingStripeCancellationId?: string;
}

async function getHouseholdBillingState(householdId: string): Promise<HouseholdBillingState> {
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
    pendingStripeCancellationId: item.pendingStripeCancellationId as string | undefined,
  };
}

export async function getHouseholdSubscription(
  householdId: string
): Promise<HouseholdSubscription> {
  const state = await getHouseholdBillingState(householdId);
  return {
    planId: state.planId,
    stripeCustomerId: state.stripeCustomerId,
    stripeSubscriptionId: state.stripeSubscriptionId,
    status: state.status,
    currentPeriodEnd: state.currentPeriodEnd,
  };
}

type SubscriptionWriteField = keyof HouseholdSubscription | 'pendingStripeCancellationId';

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
 *
 * A field set to `null` is REMOVEd from the row (vs `undefined`, which is
 * simply not written). This is how a lifetime grant clears a household's
 * stale `stripeSubscriptionId`/`currentPeriodEnd` — a one-time purchase has
 * no subscription, so leaving the old id behind would make the row claim a
 * phantom subscription.
 */
export async function updateHouseholdSubscription(
  householdId: string,
  fields: Partial<Record<SubscriptionWriteField, unknown>>,
  stripeEventCreated?: number
): Promise<boolean> {
  const setExpressions: string[] = [];
  const removeExpressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const map: Record<SubscriptionWriteField, string> = {
    planId: 'planId',
    stripeCustomerId: 'stripeCustomerId',
    stripeSubscriptionId: 'stripeSubscriptionId',
    status: 'subscriptionStatus',
    currentPeriodEnd: 'subscriptionCurrentPeriodEnd',
    pendingStripeCancellationId: 'pendingStripeCancellationId',
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const attr = map[key as SubscriptionWriteField];
    names[`#${attr}`] = attr;
    if (value === null) {
      // Explicit clear → REMOVE the attribute entirely.
      removeExpressions.push(`#${attr}`);
    } else {
      setExpressions.push(`#${attr} = :${attr}`);
      values[`:${attr}`] = value;
    }
  }
  if (setExpressions.length === 0 && removeExpressions.length === 0) return true;

  let conditionExpression: string | undefined;
  if (typeof stripeEventCreated === 'number') {
    setExpressions.push('#lastStripeEventCreated = :lastStripeEventCreated');
    names['#lastStripeEventCreated'] = 'lastStripeEventCreated';
    values[':lastStripeEventCreated'] = stripeEventCreated;
    // <= (not <) so two events minted in the same second still both apply;
    // Stripe's `created` has 1s resolution.
    conditionExpression =
      'attribute_not_exists(lastStripeEventCreated) OR lastStripeEventCreated <= :lastStripeEventCreated';
  }

  const clauses: string[] = [];
  if (setExpressions.length > 0) clauses.push(`SET ${setExpressions.join(', ')}`);
  if (removeExpressions.length > 0) clauses.push(`REMOVE ${removeExpressions.join(', ')}`);

  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
        UpdateExpression: clauses.join(' '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
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

/**
 * Billing cadence. The same `planId` (and therefore the same caps/entitlements)
 * is sold at either cadence — only the Stripe price and the headline number
 * differ — so the entire webhook/entitlement path stays cadence-agnostic and
 * resolves access off `planId` alone.
 *
 * `lifetime` is a one-time payment (Stripe `mode:'payment'`) rather than a
 * recurring subscription — it grants the same `planId` permanently with no
 * subscription to renew or cancel. Only the Garden tier offers it.
 */
export type BillingInterval = 'month' | 'year' | 'lifetime';

// Stripe subscription statuses that represent a live, billing subscription —
// as opposed to 'canceled'/'incomplete_expired', which are terminal. Used to
// decide whether a NEW checkout would create a second, concurrent
// subscription alongside one that's already charging the customer.
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

export async function createCheckoutSession(args: {
  householdId: string;
  customerEmail: string;
  planId: PlanId;
  interval?: BillingInterval;
  successUrl: string;
  cancelUrl: string;
  /** Stable per user checkout attempt. Stripe uses this to return the same
   * Session if an HTTP request is safely retried. */
  idempotencyKey?: string;
}): Promise<CheckoutSessionResult> {
  // Commercial hold: fail before configuration, DynamoDB, or Stripe access.
  // Reactivation requires both the repository status file and exact runtime
  // enablement to change under review.
  assertPaymentActivityAllowed();
  const plan = getPlan(args.planId);
  const interval: BillingInterval = args.interval ?? 'month';
  const priceEnv =
    interval === 'lifetime'
      ? plan.lifetimeStripePriceEnv
      : interval === 'year'
        ? plan.annualStripePriceEnv
        : plan.stripePriceEnv;
  if (!priceEnv) throw new Error(`Plan ${plan.id} is not billable ${interval}ly`);
  const priceId = process.env[priceEnv];
  if (!priceId) throw new Error(`Missing ${priceEnv} for plan ${plan.id}`);

  const sub = await getHouseholdSubscription(args.householdId);
  // A household with a live recurring subscription must change plans through
  // the Stripe billing portal (createPortalSession below), not by checking
  // out again: Stripe customers can hold multiple concurrent subscriptions,
  // and nothing here would replace or cancel the existing one — a second
  // checkout would silently start a SECOND subscription billing alongside
  // the first, indefinitely, until someone notices the extra charge. The
  // lifetime path is exempt: a lifetime purchase's webhook handler already
  // cancels any prior recurring subscription (see applyStripeEvent).
  if (
    interval !== 'lifetime' &&
    sub.stripeSubscriptionId &&
    sub.status &&
    LIVE_SUBSCRIPTION_STATUSES.has(sub.status)
  ) {
    throw new Error(
      'ALREADY_SUBSCRIBED: This household already has an active subscription. Use the billing portal to change plans.'
    );
  }
  const stripe = await getStripe();
  // `interval` is stamped onto metadata for analytics/debugging only —
  // entitlement is resolved from `planId`, never the cadence. A lifetime
  // checkout also records the exact subscription it intends to replace. The
  // webhook must never cancel "whatever subscription happens to be current"
  // when an old Checkout event is delivered after a newer subscription event.
  const metadata: Record<string, string> = {
    householdId: args.householdId,
    planId: plan.id,
    interval,
    ...(interval === 'lifetime' && sub.stripeSubscriptionId
      ? { replacesSubscriptionId: sub.stripeSubscriptionId }
      : {}),
  };

  // Lifetime is a one-time charge: Stripe `mode:'payment'` with NO
  // subscription_data/trial. Month/year stay recurring subscriptions exactly
  // as before. The webhook branches on `session.mode` to mirror this split.
  const common = {
    customer: sub.stripeCustomerId,
    customer_email: sub.stripeCustomerId ? undefined : args.customerEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.householdId,
    metadata,
    // Stripe Tax is opt-in because the Stripe account must first have its
    // registrations and product tax code configured. Once enabled, Checkout
    // collects the minimum address fields needed for the calculation.
    automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX_ENABLED === '1' },
    // Existing customers need this explicit opt-in for Checkout to save the
    // fresh billing address it uses for future automatic-tax calculations.
    customer_update: sub.stripeCustomerId
      ? ({ address: 'auto', name: 'auto' } as const)
      : undefined,
  };
  const createSession = (params: Stripe.Checkout.SessionCreateParams) =>
    args.idempotencyKey
      ? stripe.checkout.sessions.create(params, { idempotencyKey: args.idempotencyKey })
      : stripe.checkout.sessions.create(params);
  const session =
    interval === 'lifetime'
      ? await createSession({ mode: 'payment', ...common })
      : await createSession({
          mode: 'subscription',
          ...common,
          subscription_data: {
            metadata,
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
  // The Stripe portal can permit plan changes depending on dashboard
  // configuration, so it is a payment surface and shares Checkout's gate.
  // Webhooks remain active separately for cancellation and other
  // already-originated subscription-event processing.
  assertPaymentActivityAllowed();
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
  // `null` on stripeSubscriptionId/currentPeriodEnd means "clear this attribute"
  // (REMOVE) — used by a lifetime grant to wipe a prior subscription's stale
  // ids. Other fields keep their normal types.
  fields: Partial<Omit<HouseholdSubscription, 'stripeSubscriptionId' | 'currentPeriodEnd'>> & {
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: string | null;
  };
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

/**
 * Pull the billing cadence we stamp onto checkout-session and subscription
 * metadata at creation time (see createCheckoutSession). Enum-only — returns
 * undefined when absent or not one of our known values, so analytics never
 * carries free text. `lifetime` (`mode: 'payment'`) is a real cadence here:
 * createCheckoutSession stamps it like the recurring ones, so the confirmed
 * conversion event records one-time purchases with their true cadence.
 */
function intervalFromEvent(event: Stripe.Event): 'month' | 'year' | 'lifetime' | undefined {
  const metadata = (event.data.object as unknown as { metadata?: Record<string, string> | null })
    .metadata;
  const raw = metadata?.interval;
  return raw === 'month' || raw === 'year' || raw === 'lifetime' ? raw : undefined;
}

/**
 * Reverse-map a live Stripe price id back to our planId via the per-tier price
 * env vars. A plan change made in the Stripe billing portal swaps the
 * subscription's price but never re-stamps OUR metadata, so resolving plan
 * from the metadata alone would keep entitlement on the old tier. Deriving it
 * from the price the subscription actually carries fixes that. Returns null
 * when the price isn't one of ours (env unset — e.g. local/test — or a price
 * we don't sell), so callers fall back to metadata.
 */
function planIdFromPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  for (const plan of Object.values(PLANS)) {
    for (const env of [
      plan.stripePriceEnv,
      plan.annualStripePriceEnv,
      plan.lifetimeStripePriceEnv,
    ]) {
      if (env && process.env[env] === priceId) return plan.id;
    }
  }
  return null;
}

export function deltaForStripeEvent(event: Stripe.Event): SubscriptionDelta | null {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      const householdId = session.metadata?.householdId ?? session.client_reference_id ?? '';
      if (!householdId) return null;
      const planId = planIdFromMetadata(event, session.metadata);
      if (!planId) return null;
      const stripeCustomerId =
        typeof session.customer === 'string' ? session.customer : session.customer?.id;
      // Be defensive reading `mode`/`payment_status` — cast the object.
      const mode = (session as unknown as { mode?: string }).mode;
      const paymentStatus = (session as unknown as { payment_status?: string }).payment_status;
      if (mode === 'payment') {
        // Lifetime one-time purchase. Only grant entitlement once Stripe says
        // the charge is paid; deferred/async payment methods complete later.
        // No subscription is created, so we CLEAR any stale stripeSubscriptionId
        // and currentPeriodEnd (a prior subscriber upgrading to lifetime would
        // otherwise leave a phantom subscription on the row — and a later
        // subscription.deleted for that old sub would wrongly downgrade this
        // now-permanent household). `applyStripeEvent` also cancels the old
        // Stripe subscription so no such events ever fire. Entitlement is
        // permanent and resolves off planId alone.
        if (paymentStatus !== 'paid') return null;
        return {
          householdId,
          fields: {
            planId,
            stripeCustomerId,
            status: 'active',
            stripeSubscriptionId: null,
            currentPeriodEnd: null,
          },
        };
      }
      // mode==='subscription' (or undefined → treat as subscription for
      // back-compat with the existing recurring checkout flow).
      return {
        householdId,
        fields: {
          planId,
          stripeCustomerId,
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
      // Prefer the plan the subscription's LIVE price maps to over our
      // one-time-stamped metadata: a portal-initiated plan switch changes the
      // price but not the metadata, so trusting metadata would freeze the
      // household on the old tier's caps. Fall back to metadata when the price
      // isn't recognized (price envs unset, e.g. local/test).
      const item = sub.items?.data?.[0];
      const priceId = typeof item?.price === 'string' ? item.price : item?.price?.id;
      const planId = planIdFromPriceId(priceId) ?? planIdFromMetadata(event, sub.metadata);
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
 * ledger, see "duplicate", and drop the event. Ordinary field-only events
 * can be re-applied safely (last-write-wins fields, guarded against
 * out-of-order delivery by `lastStripeEventCreated`). Lifetime grants first
 * consult this ledger because canceling a Stripe subscription is an external
 * side effect that a completed redelivery must not repeat.
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

const STRIPE_EVENT_CLAIM_LEASE_SECONDS = 5 * 60;

type StripeEventClaim =
  { state: 'claimed'; owner: string } | { state: 'processing' } | { state: 'completed' };

/**
 * Atomically claims a lifetime event before its external cancellation side
 * effect. A plain read-then-write dedupe check lets concurrent deliveries both
 * read "missing" and both call Stripe. The conditional put elects exactly one
 * worker; contenders distinguish an in-flight claim (retryable failure) from
 * a completed event (safe success). The short lease permits recovery if a
 * Lambda dies while holding the claim, while the Stripe cancellation request
 * also carries a stable event-scoped idempotency key below.
 */
async function claimLifetimeStripeEvent(eventId: string): Promise<StripeEventClaim> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = Math.floor(Date.now() / 1000);
    const owner = randomUUID();
    try {
      await dynamodb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `STRIPE_EVENT#${eventId}`,
            SK: 'METADATA',
            entityType: 'StripeEvent',
            status: 'processing',
            claimOwner: owner,
            leaseExpiresAt: now + STRIPE_EVENT_CLAIM_LEASE_SECONDS,
            ttl: now + 30 * 24 * 60 * 60,
          },
          ConditionExpression:
            'attribute_not_exists(PK) OR (#status = :processing AND #leaseExpiresAt < :now)',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#leaseExpiresAt': 'leaseExpiresAt',
          },
          ExpressionAttributeValues: {
            ':processing': 'processing',
            ':now': now,
          },
        })
      );
      return { state: 'claimed', owner };
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'ConditionalCheckFailedException') throw err;
      const existing = await dynamodb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { PK: `STRIPE_EVENT#${eventId}`, SK: 'METADATA' },
          ProjectionExpression: '#status',
          ExpressionAttributeNames: { '#status': 'status' },
          ConsistentRead: true,
        })
      );
      // The holder may have released a failed claim between our conditional
      // failure and this read. Retry the claim once instead of treating that
      // transient absence as a completed event.
      if (!existing.Item) continue;
      return existing.Item.status === 'processing'
        ? { state: 'processing' }
        : { state: 'completed' };
    }
  }
  throw new Error(`Unable to claim Stripe event ${eventId}`);
}

async function completeLifetimeStripeEvent(eventId: string, owner: string): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `STRIPE_EVENT#${eventId}`, SK: 'METADATA' },
      UpdateExpression:
        'SET #status = :completed, #completedAt = :completedAt REMOVE #claimOwner, #leaseExpiresAt',
      ConditionExpression: '#status = :processing AND #claimOwner = :owner',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#completedAt': 'completedAt',
        '#claimOwner': 'claimOwner',
        '#leaseExpiresAt': 'leaseExpiresAt',
      },
      ExpressionAttributeValues: {
        ':completed': 'completed',
        ':completedAt': new Date().toISOString(),
        ':processing': 'processing',
        ':owner': owner,
      },
    })
  );
}

async function releaseLifetimeStripeEvent(eventId: string, owner: string): Promise<void> {
  try {
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `STRIPE_EVENT#${eventId}`, SK: 'METADATA' },
        ConditionExpression: '#status = :processing AND #claimOwner = :owner',
        ExpressionAttributeNames: { '#status': 'status', '#claimOwner': 'claimOwner' },
        ExpressionAttributeValues: { ':processing': 'processing', ':owner': owner },
      })
    );
  } catch (err) {
    // A lease takeover/completion means this invocation no longer owns the
    // claim. Never delete the successor's state.
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

async function clearPendingStripeCancellation(
  householdId: string,
  subscriptionId: string
): Promise<void> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
        UpdateExpression: 'REMOVE #pendingStripeCancellationId',
        ConditionExpression: '#pendingStripeCancellationId = :subscriptionId',
        ExpressionAttributeNames: {
          '#pendingStripeCancellationId': 'pendingStripeCancellationId',
        },
        ExpressionAttributeValues: { ':subscriptionId': subscriptionId },
      })
    );
  } catch (err) {
    // Another transition replaced/cleared the marker; never remove its value.
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  const delta = deltaForStripeEvent(event);
  if (!delta) return;

  // Guard a lifetime household against a stale `subscription.deleted` wiping
  // its permanent grant. A lifetime purchase CLEARS the stored
  // stripeSubscriptionId (and cancels the old sub below); if a deletion then
  // arrives for a subscription this household no longer references — or for a
  // household with no subscription on file at all — it must NOT downgrade to
  // seedling. (created/updated are not guarded: they re-assert a subscription
  // id, so they only ever move the row toward a consistent subscribed state,
  // and the out-of-order `event.created` guard already protects them.)
  if (event.type === 'customer.subscription.deleted') {
    const deletedSubId = (event.data.object as unknown as { id?: string }).id;
    const current = await getHouseholdSubscription(delta.householdId);
    if (!current.stripeSubscriptionId || current.stripeSubscriptionId !== deletedSubId) {
      logger.info(
        {
          stripeEventId: event.id,
          type: event.type,
          householdId: delta.householdId,
          deletedSubscriptionId: deletedSubId ?? null,
          householdSubscriptionId: current.stripeSubscriptionId ?? null,
        },
        'stripe_event_subscription_mismatch_skipped'
      );
      return;
    }
  }

  // A paid lifetime checkout clears the active subscription. Capture the exact
  // subscription recorded when Checkout began; legacy/in-flight sessions fall
  // back to an internal pending marker or the currently stored id.
  const isLifetimeGrant =
    (event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded') &&
    (event.data.object as unknown as { mode?: string }).mode === 'payment' &&
    delta.fields.stripeSubscriptionId === null;
  let lifetimeClaimOwner: string | undefined;
  let lifetimeClaimSettled = false;
  let priorSubscriptionId: string | undefined;
  if (isLifetimeGrant) {
    const claim = await claimLifetimeStripeEvent(event.id);
    if (claim.state === 'completed') {
      logger.info(
        { stripeEventId: event.id, type: event.type, householdId: delta.householdId },
        'stripe_event_duplicate_lifetime_skipped'
      );
      return;
    }
    if (claim.state === 'processing') {
      // Do not acknowledge a competing delivery while its owner may still
      // fail: a retryable error lets Stripe deliver again, whereas an early
      // 2xx could lose the cancellation permanently.
      throw new Error(`Stripe event ${event.id} is already being processed`);
    }
    lifetimeClaimOwner = claim.owner;
  }

  try {
    if (isLifetimeGrant) {
      const metadata = (
        event.data.object as unknown as { metadata?: Record<string, string> | null }
      ).metadata;
      const state = await getHouseholdBillingState(delta.householdId);
      priorSubscriptionId =
        metadata?.replacesSubscriptionId ??
        state.pendingStripeCancellationId ??
        state.stripeSubscriptionId;
    }

    // Apply FIRST, including an internal cancellation retry marker. The
    // event.created condition must succeed before any external cancellation:
    // otherwise a stale lifetime event could cancel a newer active subscription
    // and only then discover that its DDB update was out of order. If Stripe
    // cancellation fails after this write, the marker (and Checkout metadata)
    // preserve the exact target for redelivery even though the active id is now
    // cleared from the public subscription state.
    const fields = isLifetimeGrant
      ? {
          ...delta.fields,
          pendingStripeCancellationId: priorSubscriptionId ?? null,
        }
      : delta.fields;
    const applied = await updateHouseholdSubscription(delta.householdId, fields, event.created);
    if (!applied) {
      if (lifetimeClaimOwner) {
        await completeLifetimeStripeEvent(event.id, lifetimeClaimOwner);
        lifetimeClaimSettled = true;
      }
      logger.info(
        { stripeEventId: event.id, type: event.type, householdId: delta.householdId },
        'stripe_event_out_of_order_skipped'
      );
      return;
    }

    if (priorSubscriptionId) {
      try {
        const stripe = await getStripe();
        await stripe.subscriptions.cancel(
          priorSubscriptionId,
          {},
          { idempotencyKey: `lifetime-cancel:${event.id}` }
        );
        await clearPendingStripeCancellation(delta.householdId, priorSubscriptionId);
        logger.info(
          { householdId: delta.householdId, subscriptionId: priorSubscriptionId },
          'lifetime_grant_canceled_prior_subscription'
        );
      } catch (err) {
        logger.error(
          { err, householdId: delta.householdId, subscriptionId: priorSubscriptionId },
          'lifetime_grant_cancel_prior_subscription_failed'
        );
        throw err;
      }
    }

    if (lifetimeClaimOwner) {
      await completeLifetimeStripeEvent(event.id, lifetimeClaimOwner);
      lifetimeClaimSettled = true;
    }

    const isNew = isLifetimeGrant ? true : await recordStripeEventOnce(event.id);
    if (!isNew) {
      logger.info(
        { stripeEventId: event.id, type: event.type },
        'stripe_event_duplicate_reapplied'
      );
    }

    logger.info(
      { householdId: delta.householdId, fields: delta.fields, msg: 'subscription_updated' },
      'subscription_updated'
    );
    audit('billing.subscription_changed', {
      householdId: delta.householdId,
      metadata: { stripeEventType: event.type, fields: delta.fields },
    });

    // CONFIRMED conversion signal. The client fires `subscription_upgraded` at
    // checkout START (intent); this is its server-confirmed counterpart, emitted
    // once a household actually transitions to an ACTIVE paid plan (planId !=
    // seedling + status active). The Stripe webhook is the source of truth for
    // revenue.
    //
    // We restrict the emit to the ONE-TIME activation events — checkout
    // completion and subscription creation — and deliberately exclude
    // `customer.subscription.updated`. `updated` fires on every renewal, plan
    // change, and metadata edit while a subscription stays `active`; emitting on
    // it would re-fire `subscription_activated` repeatedly and inflate the
    // conversion count. (Edge: a checkout that starts in a trial fires
    // `subscription.created` with status `trialing`, so this won't double-count
    // with `checkout.session.completed`, which we stamp `active`.)
    //
    // Gated on `isNew`: an ordinary Stripe webhook REDELIVERY can re-apply its
    // idempotent fields, but the ledger prevents the conversion emit from being
    // counted twice. Completed lifetime redeliveries return earlier, before the
    // cancellation side effect or this analytics path.
    //
    // Best-effort + fire-and-forget: `capture` never throws and we `void` its
    // promise, so an analytics outage can NEVER 5xx the webhook (which would make
    // Stripe retry an already-applied delivery).
    const isActivationEvent =
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded' ||
      event.type === 'customer.subscription.created';
    const activatedPlan = delta.fields.planId;
    if (
      isNew &&
      isActivationEvent &&
      activatedPlan &&
      activatedPlan !== 'seedling' &&
      delta.fields.status === 'active'
    ) {
      void capture(delta.householdId, 'subscription_activated', {
        plan: activatedPlan,
        interval: intervalFromEvent(event),
      });
    }
  } catch (err) {
    if (lifetimeClaimOwner && !lifetimeClaimSettled) {
      try {
        await releaseLifetimeStripeEvent(event.id, lifetimeClaimOwner);
      } catch (releaseErr) {
        logger.error(
          { err: releaseErr, stripeEventId: event.id },
          'stripe_event_lifetime_claim_release_failed'
        );
      }
    }
    throw err;
  }
}

// planSummary moved to models/plans.ts so pure consumers (the dev mock
// server) can import it without dragging in this module's DynamoDB client,
// which requires TABLE_NAME at load. Re-exported to keep callers unchanged.
export { planSummary } from '../models/plans.js';

export const ALL_PLANS = Object.values(PLANS);
