import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// Mock the Stripe SDK that billing.getStripe() dynamically imports, so
// createCheckoutSession can be exercised without a network/key. `sessionsCreate`
// is hoisted (vi.mock factories run before module init) and shared so tests can
// assert what was sent to Stripe.
const { sessionsCreate, portalSessionsCreate, subscriptionsCancel, pricesRetrieve } = vi.hoisted(
  () => ({
    sessionsCreate: vi.fn(),
    portalSessionsCreate: vi.fn(),
    subscriptionsCancel: vi.fn(),
    pricesRetrieve: vi.fn(),
  })
);
vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return {
      checkout: { sessions: { create: sessionsCreate } },
      billingPortal: { sessions: { create: portalSessionsCreate } },
      subscriptions: { cancel: subscriptionsCancel },
      prices: { retrieve: pricesRetrieve },
    };
  }),
}));

/**
 * Stripe Price objects that MATCH models/plans.ts, keyed by the fake price ids
 * the checkout tests configure. createCheckoutSession reconciles the price it
 * is about to charge before creating a Session (see services/stripePrices.ts),
 * so every test that reaches Stripe needs the catalog to agree — which is the
 * point: a test that stops agreeing is a test that just caught a mispriced
 * checkout.
 */
const CATALOG_PRICES: Record<string, Record<string, unknown>> = {
  price_garden_monthly: {
    unit_amount: 499,
    currency: 'usd',
    active: true,
    recurring: { interval: 'month', interval_count: 1 },
  },
  price_garden_annual: {
    unit_amount: 3999,
    currency: 'usd',
    active: true,
    recurring: { interval: 'year', interval_count: 1 },
  },
  price_garden_lifetime: {
    unit_amount: 14900,
    currency: 'usd',
    active: true,
    recurring: null,
  },
  price_greenhouse_monthly: {
    unit_amount: 999,
    currency: 'usd',
    active: true,
    recurring: { interval: 'month', interval_count: 1 },
  },
  price_greenhouse_annual: {
    unit_amount: 7999,
    currency: 'usd',
    active: true,
    recurring: { interval: 'year', interval_count: 1 },
  },
};

/** Default: every configured price reports exactly what the catalog publishes. */
function seedCatalogPrices() {
  pricesRetrieve.mockImplementation((id: string) => {
    const price = CATALOG_PRICES[id];
    if (!price) return Promise.reject(new Error(`No such price: ${id}`));
    return Promise.resolve({ id, ...price });
  });
}

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
  BatchWriteCommand: vi.fn(function (input) {
    return { input, kind: 'BatchWrite' };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

// Mock the server analytics emitter so we can assert the confirmed-conversion
// event without hitting PostHog, and simulate it rejecting to prove the webhook
// apply path swallows analytics failures.
const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock('../../../src/utils/serverAnalytics.js', () => ({
  capture: captureMock,
}));

// The money-lifecycle emails ride this same webhook path (ADR 0023) and have
// their own suites (billingEmails.test.ts, billingEmailWebhook.test.ts).
// Mocked here so their DynamoDB reads and SES sends don't consume the mock
// responses this file queues for the subscription path.
vi.mock('../../../src/services/billingEmails.js', () => ({
  dispatchBillingEmails: vi.fn(),
}));

// Most of this file tests the retained Stripe implementation beneath the
// repository hold. Keep the exact runtime env gate in place while treating the
// status decision as reviewed-off for those mechanics tests. The real shared
// status and full allow/deny matrix have their own config test.
vi.mock('../../../src/config/commercialStatus.js', () => ({
  assertPaymentActivityAllowed: () => {
    if (process.env.PAYMENTS_ENABLED !== '1') {
      const error = new Error('Payment activity is disabled') as Error & { code?: string };
      error.code = 'PAYMENTS_DISABLED';
      throw error;
    }
  },
}));

afterEach(() => {
  delete process.env.PAYMENTS_ENABLED;
});

describe('deltaForStripeEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts householdId from checkout.session.completed metadata', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden' },
          customer: 'cus_123',
          subscription: 'sub_456',
        },
      },
    } as unknown as Stripe.Event;
    const delta = deltaForStripeEvent(event);
    expect(delta).toEqual({
      householdId: 'hh-1',
      fields: {
        planId: 'garden',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_456',
        // `status` is IMPLIED by payment_status, not guessed: a settled
        // subscription session is `active`. Where Stripe expands the
        // subscription onto the Session, its own status wins instead, and
        // customer.subscription.created/.updated own the field afterwards.
        status: 'active',
      },
    });
  });

  it('grants Garden permanently on a paid lifetime (mode=payment) checkout — no subscription id', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
          customer: 'cus_123',
        },
      },
    } as unknown as Stripe.Event;
    const delta = deltaForStripeEvent(event);
    expect(delta).toEqual({
      householdId: 'hh-1',
      fields: {
        planId: 'garden',
        stripeCustomerId: 'cus_123',
        status: 'active',
        // Explicitly cleared (REMOVE) so a prior subscriber's stale ids don't
        // linger and a later subscription.deleted can't revoke the grant.
        stripeSubscriptionId: null,
        currentPeriodEnd: null,
        // Durable record of what was bought outright. Every other field here
        // describes a subscription and is cleared or overwritten by later
        // subscription events; this is the household's entitlement floor.
        lifetimePlanId: 'garden',
        // No subscription remains, so a pending-cancellation notice from the
        // replaced one must not linger.
        cancelAtPeriodEnd: false,
      },
    });
  });

  it('tracks a pending cancellation, and clears it when the household re-subscribes', async () => {
    // Stripe does not delete a cancelled subscription immediately — it sets
    // cancel_at_period_end and keeps status active/trialing until the period
    // ends. Without carrying that flag the app shows a cancelled household
    // exactly what it showed before, so the cancellation looks like it failed.
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const build = (cancelAtPeriodEnd: boolean) =>
      deltaForStripeEvent({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            status: 'trialing',
            cancel_at_period_end: cancelAtPeriodEnd,
            metadata: { householdId: 'hh-1', planId: 'greenhouse' },
            items: { data: [{ price: 'price_x', current_period_end: 1_800_000_000 }] },
          },
        },
      } as unknown as Stripe.Event);

    expect(build(true)?.fields.cancelAtPeriodEnd).toBe(true);
    // Explicitly false, never undefined: re-subscribing must clear a stale
    // true, and `undefined` is simply not written by updateHouseholdSubscription.
    expect(build(false)?.fields.cancelAtPeriodEnd).toBe(false);
  });

  it('clears a pending cancellation when a lifetime purchase replaces the subscription', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const delta = deltaForStripeEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event);
    // No subscription remains, so a cancellation notice from the replaced one
    // must not linger on a household that now owns its tier outright.
    expect(delta?.fields.cancelAtPeriodEnd).toBe(false);
  });

  it('records a trial checkout as trialing, never as active', async () => {
    // checkout.session.completed references the subscription by id and does
    // not carry its status, so the old hardcoded 'active' was a guess — and
    // wrong for every checkout that starts a trial. Whichever of the two
    // events landed last won, so a trialing household could be recorded as
    // active and never be told it was on a trial or when its first charge
    // would land. The status is now IMPLIED by payment_status rather than
    // guessed: a subscription-mode session that required no payment is a
    // trial, and Stripe always sends payment_status on a Session.
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const delta = deltaForStripeEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          payment_status: 'no_payment_required',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'month' },
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    } as unknown as Stripe.Event);

    expect(delta?.fields.stripeSubscriptionId).toBe('sub_1');
    expect(delta?.fields.status).toBe('trialing');
  });

  it('uses the subscription status when Stripe expanded it for us', async () => {
    // Stripe's own expanded status beats the one implied by payment_status:
    // `paid` would imply `active`, but the expanded subscription says the
    // trial is still running, and Stripe is the authority on its own object.
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const delta = deltaForStripeEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'month' },
          customer: 'cus_1',
          subscription: { id: 'sub_1', status: 'trialing' },
        },
      },
    } as unknown as Stripe.Event);

    expect(delta?.fields.status).toBe('trialing');
  });

  it('records the lifetime tier durably so it survives a later subscription', async () => {
    // Regression: a lifetime purchase has no subscription id, which made
    // ownership invisible to both guards that prevent paying twice. A
    // lifetime owner could be sold a subscription, and cancelling it later
    // dropped them to seedling — destroying a one-time purchase with no
    // refund path.
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const delta = deltaForStripeEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
          customer: 'cus_123',
        },
      },
    } as unknown as Stripe.Event);
    expect(delta?.fields.lifetimePlanId).toBe('garden');
    // Never written by a subscription checkout — only an outright purchase
    // may set the floor.
    const subDelta = deltaForStripeEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'greenhouse', interval: 'month' },
          customer: 'cus_123',
          subscription: 'sub_1',
        },
      },
    } as unknown as Stripe.Event);
    expect(subDelta?.fields).not.toHaveProperty('lifetimePlanId');
  });

  it('does NOT grant entitlement on an unpaid lifetime (mode=payment) checkout', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'unpaid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
          customer: 'cus_123',
        },
      },
    } as unknown as Stripe.Event;
    expect(deltaForStripeEvent(event)).toBeNull();
  });

  it('grants entitlement when a delayed lifetime payment later succeeds', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
          customer: 'cus_123',
        },
      },
    } as unknown as Stripe.Event;

    expect(deltaForStripeEvent(event)).toMatchObject({
      householdId: 'hh-1',
      fields: { planId: 'garden', status: 'active', stripeSubscriptionId: null },
    });
  });

  it('treats a checkout.session.completed with mode=subscription as before (subscription id retained)', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden' },
          customer: 'cus_123',
          subscription: 'sub_456',
        },
      },
    } as unknown as Stripe.Event;
    expect(deltaForStripeEvent(event)).toEqual({
      householdId: 'hh-1',
      fields: {
        planId: 'garden',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_456',
        // `status` is IMPLIED by payment_status, not guessed: a settled
        // subscription session is `active`. Where Stripe expands the
        // subscription onto the Session, its own status wins instead, and
        // customer.subscription.created/.updated own the field afterwards.
        status: 'active',
      },
    });
  });

  it('falls back to seedling on subscription deletion', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: { metadata: { householdId: 'hh-1', planId: 'greenhouse' } },
      },
    } as unknown as Stripe.Event;
    const delta = deltaForStripeEvent(event);
    expect(delta?.fields.planId).toBe('seedling');
    expect(delta?.fields.status).toBe('canceled');
  });

  it('returns null for unrelated events', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      type: 'invoice.paid',
      data: { object: {} },
    } as unknown as Stripe.Event;
    expect(deltaForStripeEvent(event)).toBeNull();
  });

  it('returns null when householdId metadata missing', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      type: 'checkout.session.completed',
      data: { object: { metadata: {}, client_reference_id: null } },
    } as unknown as Stripe.Event;
    expect(deltaForStripeEvent(event)).toBeNull();
  });

  it('rejects checkout events with missing planId metadata instead of defaulting to a paid plan', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      id: 'evt_no_plan',
      type: 'checkout.session.completed',
      data: {
        object: { metadata: { householdId: 'hh-1' }, customer: 'cus_1', subscription: 'sub_1' },
      },
    } as unknown as Stripe.Event;
    expect(deltaForStripeEvent(event)).toBeNull();
  });

  it('rejects subscription events with an unknown planId', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      id: 'evt_bad_plan',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { householdId: 'hh-1', planId: 'toString' },
        },
      },
    } as unknown as Stripe.Event;
    expect(deltaForStripeEvent(event)).toBeNull();
  });

  it('resolves planId from the LIVE subscription price (portal plan change), not stale metadata', async () => {
    // A plan switch in the Stripe billing portal swaps the price but never
    // re-stamps our metadata. Entitlement must follow the price the
    // subscription now carries, or the household keeps the old tier's caps.
    process.env.STRIPE_PRICE_ID_GREENHOUSE_ANNUAL = 'price_gh_annual';
    try {
      const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
      const delta = deltaForStripeEvent({
        id: 'evt_portal_change',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            status: 'active',
            metadata: { householdId: 'hh-1', planId: 'garden' }, // stale (original checkout)
            items: {
              data: [{ price: { id: 'price_gh_annual' }, current_period_end: 1_700_000_000 }],
            },
          },
        },
      } as unknown as Stripe.Event);
      expect(delta?.fields.planId).toBe('greenhouse');
    } finally {
      delete process.env.STRIPE_PRICE_ID_GREENHOUSE_ANNUAL;
    }
  });

  it('falls back to metadata planId when the subscription price is not one we sell (envs unset)', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const delta = deltaForStripeEvent({
      id: 'evt_unknown_price',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { householdId: 'hh-1', planId: 'garden' },
          items: { data: [{ price: { id: 'price_we_dont_recognize' } }] },
        },
      },
    } as unknown as Stripe.Event);
    expect(delta?.fields.planId).toBe('garden');
  });
});

describe('recordStripeEventOnce / applyStripeEvent idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true the first time an event id is seen', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { recordStripeEventOnce } = await import('../../../src/services/billing.js');
    expect(await recordStripeEventOnce('evt_1')).toBe(true);
    const putArg = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ConditionExpression: string; Item: { PK: string; ttl: number } };
    };
    expect(putArg.input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(putArg.input.Item.PK).toBe('STRIPE_EVENT#evt_1');
    expect(putArg.input.Item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns false when the event id was already recorded', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const conditionErr = Object.assign(new Error('exists'), {
      name: 'ConditionalCheckFailedException',
    });
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditionErr);
    const { recordStripeEventOnce } = await import('../../../src/services/billing.js');
    expect(await recordStripeEventOnce('evt_dup')).toBe(false);
  });

  it('applies the subscription update BEFORE recording the dedupe ledger row', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_new',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden' },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event);
    const calls = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: Record<string, unknown> });
    expect(calls).toHaveLength(2);
    // Apply-first ordering: a failed apply must NOT leave a ledger row behind,
    // or Stripe's retry would be skipped as a "duplicate" forever.
    expect(calls[0].kind).toBe('Update');
    expect(calls[1].kind).toBe('Put');
    expect((calls[1].input as { Item: { PK: string } }).Item.PK).toBe('STRIPE_EVENT#evt_new');
  });

  it('a failed apply leaves no ledger row, so the Stripe retry succeeds', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      id: 'evt_retry',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden' },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event;

    // First delivery: the household Update throws (transient DDB failure) and
    // the error propagates → webhook returns 5xx → Stripe will retry.
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('DDB throttled'));
    await expect(applyStripeEvent(event)).rejects.toThrow('DDB throttled');
    // Crucially: no ledger Put was attempted before the failure.
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);

    // Retry delivery: both writes succeed.
    vi.mocked(dynamodb.send).mockResolvedValue({});
    await applyStripeEvent(event);
    const retryCalls = vi
      .mocked(dynamodb.send)
      .mock.calls.slice(1)
      .map((c) => c[0] as unknown as { kind: string });
    expect(retryCalls.map((c) => c.kind)).toEqual(['Update', 'Put']);
  });

  it('still applies (harmlessly) when the ledger says duplicate', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const conditionErr = Object.assign(new Error('exists'), {
      name: 'ConditionalCheckFailedException',
    });
    // Apply succeeds, ledger Put reports duplicate — must not throw.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({}).mockRejectedValueOnce(conditionErr);
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_dup',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden' },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event);
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(2);
  });

  it('skips out-of-order events (stored lastStripeEventCreated is newer)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const conditionErr = Object.assign(new Error('stale'), {
      name: 'ConditionalCheckFailedException',
    });
    // The conditioned household Update fails: a newer event already applied.
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditionErr);
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_stale',
      created: 1_600_000_000,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { householdId: 'hh-1', planId: 'garden' },
        },
      },
    } as unknown as Stripe.Event);
    // Update attempted, skipped as stale; no ledger write, no throw.
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);
  });

  it('stamps event.created on the household row with an out-of-order guard condition', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { updateHouseholdSubscription } = await import('../../../src/services/billing.js');
    const applied = await updateHouseholdSubscription(
      'hh-1',
      { planId: 'garden', status: 'active' },
      1_700_000_123
    );
    expect(applied).toBe(true);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: {
        ConditionExpression: string;
        UpdateExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(cmd.input.ConditionExpression).toContain(
      'lastStripeEventCreated <= :lastStripeEventCreated'
    );
    expect(cmd.input.UpdateExpression).toContain(
      '#lastStripeEventCreated = :lastStripeEventCreated'
    );
    expect(cmd.input.ExpressionAttributeValues[':lastStripeEventCreated']).toBe(1_700_000_123);
  });

  it('REMOVEs an attribute when its field is null (lifetime clears stale subscription ids)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { updateHouseholdSubscription } = await import('../../../src/services/billing.js');
    await updateHouseholdSubscription('hh-1', {
      planId: 'garden',
      status: 'active',
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    });
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { UpdateExpression: string; ExpressionAttributeNames: Record<string, string> };
    };
    expect(cmd.input.UpdateExpression).toMatch(/^SET .*\bREMOVE\b/);
    expect(cmd.input.UpdateExpression).toContain('REMOVE #stripeSubscriptionId');
    expect(cmd.input.UpdateExpression).toContain('#subscriptionCurrentPeriodEnd');
    // SET side keeps the non-null fields.
    expect(cmd.input.UpdateExpression).toContain('#planId = :planId');
  });

  it('cancels the prior Stripe subscription when a lifetime payment grants Garden', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    // 1st send: ledger pre-read → not recorded. 2nd: billing-state read →
    // prior sub on file. Remaining sends stage, clear, then record the event.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Item: { stripeSubscriptionId: 'sub_old', planId: 'garden' } })
      .mockResolvedValue({});
    subscriptionsCancel.mockResolvedValueOnce({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_lifetime',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event);
    expect(subscriptionsCancel).toHaveBeenCalledWith(
      'sub_old',
      {},
      { idempotencyKey: 'lifetime-cancel:evt_lifetime' }
    );
  });

  it('restores the lifetime tier when a subscription taken out on top of it is cancelled', async () => {
    // The defect this pins: a lifetime household has no stripeSubscriptionId,
    // so it could still be sold a subscription for a higher tier. Cancelling
    // that subscription used to set planId='seedling', destroying a one-time
    // purchase outright — no refund, no warning, no way back.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      // billing-state read: owns Garden for life, currently subscribed to
      // Greenhouse on top of it.
      .mockResolvedValueOnce({
        Item: {
          planId: 'greenhouse',
          stripeSubscriptionId: 'sub_gh',
          lifetimePlanId: 'garden',
        },
      })
      .mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_cancel',
      created: 1_700_000_100,
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_gh', metadata: { householdId: 'hh-1' } } },
    } as unknown as Stripe.Event);

    const writes = vi.mocked(dynamodb.send).mock.calls.map((c) => JSON.stringify(c[0]));
    const update = writes.find((w) => w.includes('planId'));
    expect(update).toBeDefined();
    // Falls back to what was actually paid for, NOT seedling.
    expect(update).toContain('garden');
    expect(update).not.toContain('seedling');
  });

  it('stages the exact cancellation target before clearing the public subscription id', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    // The conditioned household update stores a private retry marker before
    // cancellation. A Stripe redelivery can therefore recover sub_old even
    // though the public stripeSubscriptionId is cleared by the lifetime grant.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({
        Item: { stripeSubscriptionId: 'sub_old', planId: 'garden' },
      });
    subscriptionsCancel.mockRejectedValueOnce(new Error('stripe unavailable'));
    const { applyStripeEvent } = await import('../../../src/services/billing.js');

    await expect(
      applyStripeEvent({
        id: 'evt_lifetime_retry',
        created: 1_700_000_000,
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'payment',
            payment_status: 'paid',
            metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
            customer: 'cus_1',
          },
        },
      } as unknown as Stripe.Event)
    ).rejects.toThrow('stripe unavailable');

    expect(subscriptionsCancel).toHaveBeenCalledWith(
      'sub_old',
      {},
      { idempotencyKey: 'lifetime-cancel:evt_lifetime_retry' }
    );
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(4);
    const stage = vi.mocked(dynamodb.send).mock.calls[2][0] as unknown as {
      input: {
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(stage.input.UpdateExpression).toContain(
      '#pendingStripeCancellationId = :pendingStripeCancellationId'
    );
    expect(stage.input.ExpressionAttributeValues[':pendingStripeCancellationId']).toBe('sub_old');
    expect(stage.input.ConditionExpression).toContain('lastStripeEventCreated');
  });

  it('a Stripe redelivery after a failed cancel retries against the SAME prior subscription id', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      id: 'evt_lifetime_retry_2',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event;

    // First delivery: the target is staged atomically with the entitlement,
    // then cancellation fails.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({
        Item: { stripeSubscriptionId: 'sub_old', planId: 'garden' },
      })
      .mockResolvedValueOnce({});
    subscriptionsCancel.mockRejectedValueOnce(new Error('stripe unavailable'));
    await expect(applyStripeEvent(event)).rejects.toThrow('stripe unavailable');

    // Stripe redelivers the identical event. The active id is now cleared, but
    // the private pending marker preserves sub_old for the retry.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({
        Item: { pendingStripeCancellationId: 'sub_old', planId: 'garden' },
      })
      .mockResolvedValue({});
    subscriptionsCancel.mockResolvedValueOnce({});
    await applyStripeEvent(event);

    expect(subscriptionsCancel).toHaveBeenCalledTimes(2);
    expect(subscriptionsCancel).toHaveBeenNthCalledWith(
      1,
      'sub_old',
      {},
      { idempotencyKey: 'lifetime-cancel:evt_lifetime_retry_2' }
    );
    expect(subscriptionsCancel).toHaveBeenNthCalledWith(
      2,
      'sub_old',
      {},
      { idempotencyKey: 'lifetime-cancel:evt_lifetime_retry_2' }
    );
  });

  it('never cancels a subscription when a lifetime event loses the out-of-order condition', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    const conditionErr = Object.assign(new Error('stale'), {
      name: 'ConditionalCheckFailedException',
    });
    vi.mocked(dynamodb.send)
      // The event has not completed before, so there is no ledger row.
      .mockResolvedValueOnce({ Item: undefined })
      // A newer subscription is currently active.
      .mockResolvedValueOnce({
        Item: { stripeSubscriptionId: 'sub_new', planId: 'greenhouse' },
      })
      // The lifetime event is older, so its conditioned entitlement/staging
      // write is rejected before any Stripe side effect.
      .mockRejectedValueOnce(conditionErr);
    const { applyStripeEvent } = await import('../../../src/services/billing.js');

    await applyStripeEvent({
      id: 'evt_stale_lifetime',
      created: 1_600_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: {
            householdId: 'hh-1',
            planId: 'garden',
            interval: 'lifetime',
            replacesSubscriptionId: 'sub_old',
          },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event);

    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(4);
  });

  it('does not cancel again after a completed lifetime event is redelivered', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    const alreadyExists = Object.assign(new Error('recorded'), {
      name: 'ConditionalCheckFailedException',
    });
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(alreadyExists)
      .mockResolvedValueOnce({
        Item: { PK: 'STRIPE_EVENT#evt_lifetime_done', status: 'completed' },
      });
    const { applyStripeEvent } = await import('../../../src/services/billing.js');

    await applyStripeEvent({
      id: 'evt_lifetime_done',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: {
            householdId: 'hh-1',
            planId: 'garden',
            interval: 'lifetime',
            replacesSubscriptionId: 'sub_old',
          },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event);

    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(2);
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });

  it('atomically elects one cancellation worker for concurrent duplicate lifetime deliveries', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    let claimed = false;
    let claimStatus = 'processing';
    const conditional = () =>
      Object.assign(new Error('claimed'), { name: 'ConditionalCheckFailedException' });
    vi.mocked(dynamodb.send).mockImplementation(async (command: unknown) => {
      const typed = command as {
        kind?: string;
        input?: {
          Item?: Record<string, unknown>;
          Key?: Record<string, unknown>;
          UpdateExpression?: string;
        };
      };
      if (typed.kind === 'Put' && String(typed.input?.Item?.PK).startsWith('STRIPE_EVENT#')) {
        if (claimed) throw conditional();
        claimed = true;
        return {};
      }
      if (typed.kind === 'Get' && String(typed.input?.Key?.PK).startsWith('STRIPE_EVENT#')) {
        return { Item: { status: claimStatus } };
      }
      if (typed.kind === 'Get') {
        return { Item: { stripeSubscriptionId: 'sub_old', planId: 'garden' } };
      }
      if (typed.input?.UpdateExpression?.includes('#status = :completed')) {
        claimStatus = 'completed';
      }
      return {};
    });

    let releaseCancel!: () => void;
    const cancelStarted = new Promise<void>((resolveStarted) => {
      subscriptionsCancel.mockImplementationOnce(
        () =>
          new Promise((resolveCancel) => {
            releaseCancel = () => resolveCancel({});
            resolveStarted();
          })
      );
    });
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    const event = {
      id: 'evt_lifetime_concurrent',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: {
            householdId: 'hh-1',
            planId: 'garden',
            interval: 'lifetime',
            replacesSubscriptionId: 'sub_old',
          },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event;

    const first = applyStripeEvent(event);
    await cancelStarted;
    await expect(applyStripeEvent(event)).rejects.toThrow('already being processed');
    expect(subscriptionsCancel).toHaveBeenCalledTimes(1);

    releaseCancel();
    await first;
    expect(subscriptionsCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT downgrade a lifetime household on a subscription.deleted for an unknown sub', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // Pre-apply read: the lifetime grant cleared the sub id (none on file).
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { planId: 'garden' } });
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_del_orphan',
      created: 1_700_000_000,
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_old', metadata: { householdId: 'hh-1', planId: 'garden' } },
      },
    } as unknown as Stripe.Event);
    // Only the guard read ran — no Update (no downgrade), no ledger Put.
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);
  });

  it('still downgrades to seedling when subscription.deleted matches the stored sub id', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // Pre-apply read: household still references this very subscription.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { planId: 'garden', stripeSubscriptionId: 'sub_live' } })
      .mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_del_match',
      created: 1_700_000_000,
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_live', metadata: { householdId: 'hh-1', planId: 'greenhouse' } },
      },
    } as unknown as Stripe.Event);
    // Guard read + Update (downgrade) + ledger Put.
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(3);
    const updateCmd = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(updateCmd.input.ExpressionAttributeValues[':planId']).toBe('seedling');
  });
});

describe('applyStripeEvent — identification top-up grant (ADR 0019)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const conditionErr = () =>
    Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });

  function topUpEvent(over: { id?: string; payment_status?: string; type?: string } = {}) {
    return {
      id: over.id ?? 'evt_topup_1',
      created: 1_756_857_600,
      type: over.type ?? 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_topup_1',
          mode: 'payment',
          payment_status: over.payment_status ?? 'paid',
          customer: 'cus_1',
          metadata: { householdId: 'hh-1', purchase: 'identify_top_up', credits: '20' },
        },
      },
    } as unknown as Stripe.Event;
  }

  type Sent = { kind: string; input: Record<string, any> };
  const sentCalls = async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    return vi.mocked(dynamodb.send).mock.calls.map((c) => c[0] as unknown as Sent);
  };

  it('grants the pack row keyed by the session, then records the ledger — and never touches the household row', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(topUpEvent());
    const calls = await sentCalls();
    expect(calls.map((c) => c.kind)).toEqual(['Put', 'Put']);
    // The grant: idempotent by its own key.
    expect(calls[0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(calls[0].input.Item).toMatchObject({
      PK: 'HOUSEHOLD#hh-1',
      SK: 'IDCREDIT#cs_topup_1',
      granted: 20,
      remaining: 20,
      purchasedAt: new Date(1_756_857_600 * 1000).toISOString(),
    });
    // Then the shared dedupe ledger, in the same apply-then-record order as
    // every other event.
    expect(calls[1].input.Item.PK).toBe('STRIPE_EVENT#evt_topup_1');
    // No subscription write of any kind: a pack is credits, not entitlement.
    expect(calls.some((c) => c.kind === 'Update')).toBe(false);
    // Not a subscription activation: no lifecycle analytics.
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('a second delivery of the same event grants NOTHING, whatever the ledger says', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // The pack row already exists (conditional put refused); the ledger row
    // does NOT (the first delivery crashed between grant and ledger write).
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditionErr()).mockResolvedValueOnce({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await expect(applyStripeEvent(topUpEvent())).resolves.toBeUndefined();
    const calls = await sentCalls();
    expect(calls.map((c) => c.kind)).toEqual(['Put', 'Put']);
    expect(calls[0].input.Item.SK).toBe('IDCREDIT#cs_topup_1');
    // No throw: Stripe gets its 2xx and stops retrying.
  });

  it('a redelivery where BOTH the pack and the ledger already exist is a silent no-op', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(conditionErr())
      .mockRejectedValueOnce(conditionErr());
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await expect(applyStripeEvent(topUpEvent())).resolves.toBeUndefined();
  });

  it('a failed grant write propagates so Stripe retries, and leaves no ledger row behind', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('DDB throttled'));
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await expect(applyStripeEvent(topUpEvent())).rejects.toThrow('DDB throttled');
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);
  });

  it('an UNPAID top-up checkout grants nothing and is not mistaken for a malformed lifetime purchase', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { applyStripeEvent, deltaForStripeEvent } =
      await import('../../../src/services/billing.js');
    const unpaid = topUpEvent({ payment_status: 'unpaid' });
    expect(deltaForStripeEvent(unpaid)).toBeNull();
    await applyStripeEvent(unpaid);
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('grants on the later async_payment_succeeded for a deferred payment method', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(
      topUpEvent({ type: 'checkout.session.async_payment_succeeded', id: 'evt_async' })
    );
    const calls = await sentCalls();
    expect(calls[0].input.Item.SK).toBe('IDCREDIT#cs_topup_1');
    expect(calls[1].input.Item.PK).toBe('STRIPE_EVENT#evt_async');
  });

  it('a lifetime (mode=payment) checkout still takes the subscription path — the marker, not the mode, decides', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({ Item: undefined });
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_life',
      created: 1_756_857_600,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_life',
          mode: 'payment',
          payment_status: 'paid',
          customer: 'cus_1',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
        },
      },
    } as unknown as Stripe.Event);
    const calls = await sentCalls();
    expect(calls.some((c) => c.kind === 'Update' && c.input.Key?.PK === 'HOUSEHOLD#hh-1')).toBe(
      true
    );
    expect(
      calls.some((c) => c.kind === 'Put' && String(c.input.Item?.SK).startsWith('IDCREDIT#'))
    ).toBe(false);
  });
});

describe('applyStripeEvent — confirmed-conversion analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureMock.mockResolvedValue(undefined);
  });

  it('emits subscription_activated when a household transitions to an active paid plan', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_activate',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'year' },
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_activated', {
      plan: 'garden',
      interval: 'year',
    });
  });

  it('emits subscription_deactivated (not subscription_activated) on a cancellation', async () => {
    // A cancellation must never look like an activation, and must no longer be
    // silent: churn used to reach analytics as nothing at all, so "how many
    // paying households cancelled?" could only be answered by grepping the
    // generic `subscription_updated` log line.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // Guard read (subscription matches) + Update + ledger Put.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { planId: 'garden', stripeSubscriptionId: 'sub_live' } })
      .mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_cancel',
      created: 1_700_000_000,
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_live',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'month' },
          cancellation_details: { reason: 'cancellation_requested' },
        },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_deactivated', {
      // The tier the household LOST, read before the delta rewrote planId to
      // 'seedling' — not the tier it fell to.
      plan: 'garden',
      interval: 'month',
      churnReason: 'requested',
    });
  });

  it('does NOT re-emit on customer.subscription.updated (renewal/plan-change) to avoid inflating conversions', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_renewal',
      created: 1_700_000_000,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'month' },
        },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does NOT emit on customer.subscription.created — the checkout event already counted it', async () => {
    // Every subscription this app creates originates from a checkout, so
    // subscription.created always accompanies checkout.session.completed.
    // Counting both would double-count one conversion. A subscription created
    // outside checkout records nothing, which is correct: nobody converted.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_created',
      created: 1_700_000_000,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { householdId: 'hh-1', planId: 'greenhouse', interval: 'month' },
        },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('records interval=lifetime for a one-time (mode=payment) Garden purchase', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_lifetime',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'payment',
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
          customer: 'cus_1',
        },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_activated', {
      plan: 'garden',
      interval: 'lifetime',
    });
  });

  it('does NOT re-emit subscription_activated on a webhook REDELIVERY (already-recorded event)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const conditionErr = Object.assign(new Error('exists'), {
      name: 'ConditionalCheckFailedException',
    });
    // Apply re-runs (idempotent), but the ledger Put reports the event id was
    // already recorded → isNew=false → the conversion is NOT counted again.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({}).mockRejectedValueOnce(conditionErr);
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_redelivered',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'year' },
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('omits interval when the Stripe metadata carries none', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_no_interval',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          metadata: { householdId: 'hh-1', planId: 'greenhouse' },
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_activated', {
      plan: 'greenhouse',
      interval: undefined,
    });
  });

  it('does NOT throw when the analytics emitter rejects (webhook must never 5xx on analytics)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    // The emitter is best-effort + fire-and-forget; a rejected promise from it
    // must not surface to the webhook (which would make Stripe retry).
    captureMock.mockRejectedValue(new Error('posthog down'));
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await expect(
      applyStripeEvent({
        id: 'evt_analytics_fail',
        created: 1_700_000_000,
        type: 'checkout.session.completed',
        data: {
          object: {
            payment_status: 'paid',
            metadata: { householdId: 'hh-1', planId: 'garden', interval: 'month' },
            customer: 'cus_1',
            subscription: 'sub_1',
          },
        },
      } as unknown as Stripe.Event)
    ).resolves.toBeUndefined();
    expect(captureMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Paid conversion — the number that was previously unobservable.
 *
 * Every subscription checkout carries `trial_period_days: 14`, so
 * `subscription_activated` counts trial STARTS. Money moves later, when Stripe
 * takes the first charge and moves the subscription from `trialing` to
 * `active`. These tests pin that distinction down in both directions: the
 * transition must fire, and everything that merely resembles it must not.
 */
describe('applyStripeEvent — paid-conversion analytics (subscription_paid)', () => {
  const conditionErr = () =>
    Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });

  /** A `customer.subscription.updated` carrying a status change in its diff. */
  const statusChange = (args: {
    id: string;
    from?: string;
    to: string;
    planId?: string;
    interval?: string;
  }) =>
    ({
      id: args.id,
      created: 1_700_000_000,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: args.to,
          metadata: {
            householdId: 'hh-1',
            planId: args.planId ?? 'garden',
            ...(args.interval ? { interval: args.interval } : {}),
          },
        },
        // Stripe attaches the pre-change values of exactly the fields that
        // changed. `status` present here is what makes this a transition.
        ...(args.from ? { previous_attributes: { status: args.from } } : {}),
      },
    }) as unknown as Stripe.Event;

  beforeEach(() => {
    vi.clearAllMocks();
    captureMock.mockResolvedValue(undefined);
  });

  it('emits subscription_paid when a trial converts (trialing → active)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(
      statusChange({ id: 'evt_paid', from: 'trialing', to: 'active', interval: 'month' })
    );
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_paid', {
      plan: 'garden',
      interval: 'month',
      from: 'trialing',
    });
  });

  it('emits subscription_paid with from=past_due when a failed first charge is later recovered', async () => {
    // Real revenue, but NOT a new trial conversion — `from` is what keeps the
    // two countable separately instead of collapsing into one wrong number.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(
      statusChange({ id: 'evt_recovered', from: 'past_due', to: 'active', interval: 'year' })
    );
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_paid', {
      plan: 'garden',
      interval: 'year',
      from: 'past_due',
    });
  });

  it('does NOT emit when a trial ends in a FAILED charge (trialing → past_due)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(statusChange({ id: 'evt_failed', from: 'trialing', to: 'past_due' }));
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does NOT emit on a RENEWAL — status is absent from previous_attributes', async () => {
    // A monthly renewal re-bills but leaves the subscription `active`, so
    // Stripe's diff contains no `status`. This is the case that would have
    // inflated the count into meaninglessness.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(statusChange({ id: 'evt_renew', to: 'active' }));
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does NOT emit on a plan change between two active states (active → active)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(
      statusChange({ id: 'evt_switch', from: 'active', to: 'active', planId: 'greenhouse' })
    );
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does NOT emit at TRIAL START — a trialing subscription is not revenue', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_trial_start',
      created: 1_700_000_000,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          status: 'trialing',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'month' },
        },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does NOT double-count a paid conversion on a webhook REDELIVERY', async () => {
    // Stripe webhooks are at-least-once. The apply is idempotent and re-runs,
    // but the dedupe ledger reports the event id as already recorded, so the
    // revenue emit happens exactly once for the same delivery.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    const event = statusChange({
      id: 'evt_paid_dupe',
      from: 'trialing',
      to: 'active',
      interval: 'month',
    });

    // First delivery: Update succeeds, ledger Put succeeds → counted.
    vi.mocked(dynamodb.send).mockResolvedValue({});
    await applyStripeEvent(event);
    expect(captureMock).toHaveBeenCalledTimes(1);

    // Redelivery of the SAME event id: Update re-applies, ledger Put is
    // rejected by its attribute_not_exists condition → not counted again.
    vi.mocked(dynamodb.send).mockReset();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({}).mockRejectedValueOnce(conditionErr());
    await applyStripeEvent(event);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit when the write is rejected as OUT OF ORDER', async () => {
    // A stale delivery that loses to `lastStripeEventCreated` never applied, so
    // it must not report revenue either.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditionErr());
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(statusChange({ id: 'evt_stale', from: 'trialing', to: 'active' }));
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('buckets an unfamiliar previous status rather than leaking it as free text', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(
      statusChange({ id: 'evt_odd', from: 'some_future_stripe_status', to: 'active' })
    );
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_paid', {
      plan: 'garden',
      interval: undefined,
      from: 'other',
    });
  });
});

describe('applyStripeEvent — churn analytics (subscription_deactivated)', () => {
  const conditionErr = () =>
    Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });

  const deletion = (id: string, reason?: string) =>
    ({
      id,
      created: 1_700_000_000,
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_live',
          metadata: { householdId: 'hh-1', planId: 'garden', interval: 'month' },
          ...(reason ? { cancellation_details: { reason } } : {}),
        },
      },
    }) as unknown as Stripe.Event;

  beforeEach(() => {
    vi.clearAllMocks();
    captureMock.mockResolvedValue(undefined);
  });

  it('omits churnReason when Stripe recorded none, rather than inventing one', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { planId: 'greenhouse', stripeSubscriptionId: 'sub_live' } })
      .mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(deletion('evt_churn_noreason'));
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_deactivated', {
      plan: 'greenhouse',
      interval: 'month',
    });
  });

  it('distinguishes involuntary churn (payment_failed) from a requested cancellation', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { planId: 'garden', stripeSubscriptionId: 'sub_live' } })
      .mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(deletion('evt_churn_dunning', 'payment_failed'));
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_deactivated', {
      plan: 'garden',
      interval: 'month',
      churnReason: 'payment_failed',
    });
  });

  it('does NOT emit for a household that was already on the free tier', async () => {
    // A subscription ending for a household with no paid tier is not churn.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { planId: 'seedling', stripeSubscriptionId: 'sub_live' } })
      .mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(deletion('evt_churn_free'));
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does NOT emit for a deletion of a subscription the household no longer references', async () => {
    // The mismatch guard returns before the analytics path, so a stale deletion
    // for a replaced subscription never reports churn that did not happen.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { planId: 'garden', stripeSubscriptionId: 'sub_other' },
    });
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(deletion('evt_churn_orphan'));
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('reports the tier a lifetime household lost, not the tier it keeps', async () => {
    // The recurring subscription really ended; the permanent grant underneath
    // survives, and `delta.fields.planId` is restored to it. The churn event
    // must still describe what stopped being billed.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Item: {
          planId: 'greenhouse',
          stripeSubscriptionId: 'sub_live',
          lifetimePlanId: 'garden',
        },
      })
      .mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent(deletion('evt_churn_lifetime', 'cancellation_requested'));
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_deactivated', {
      plan: 'greenhouse',
      interval: 'month',
      churnReason: 'requested',
    });
  });

  it('does NOT double-count churn on a webhook REDELIVERY', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    const event = deletion('evt_churn_dupe', 'cancellation_requested');

    // First delivery: guard read + Update + ledger Put all succeed.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { planId: 'garden', stripeSubscriptionId: 'sub_live' } })
      .mockResolvedValue({});
    await applyStripeEvent(event);
    expect(captureMock).toHaveBeenCalledTimes(1);

    // Redelivery: the deletion delta does not clear stripeSubscriptionId, so
    // the guard still matches and the apply re-runs — but the ledger rejects
    // the already-recorded event id, so churn is counted exactly once.
    vi.mocked(dynamodb.send).mockReset();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { planId: 'garden', stripeSubscriptionId: 'sub_live' } })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conditionErr());
    await applyStripeEvent(event);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });
});

describe('planSummary', () => {
  it('publishes a WITHDRAWN annual cadence as null — the same signal as "no such cadence"', async () => {
    // Annual is withdrawn from sale on both paid tiers (2026-09-02). The
    // price stays on the catalog for existing subscribers, but the public
    // projection must not offer it: null is what the client already renders
    // as "not available", so the interval toggle disappears on its own.
    const { planSummary } = await import('../../../src/services/billing.js');
    const { PLANS } = await import('../../../src/models/plans.js');
    expect(planSummary(PLANS.seedling, true).annualPrice).toBeNull();
    expect(planSummary(PLANS.garden, true).annualPrice).toBeNull();
    expect(planSummary(PLANS.greenhouse, true).annualPrice).toBeNull();
    // ...while the catalog itself still knows the amount.
    expect(PLANS.garden.annualPrice).toBe(39.99);
    expect(PLANS.greenhouse.annualPrice).toBe(79.99);
  });

  it('publishes the WITHDRAWN Garden lifetime as null, and still null where there never was one', async () => {
    const { planSummary } = await import('../../../src/services/billing.js');
    const { PLANS } = await import('../../../src/models/plans.js');
    expect(planSummary(PLANS.garden, true).lifetimePrice).toBeNull();
    expect(planSummary(PLANS.seedling, true).lifetimePrice).toBeNull();
    expect(planSummary(PLANS.greenhouse, true).lifetimePrice).toBeNull();
    expect(PLANS.garden.lifetimePrice).toBe(149);
  });

  it('still publishes the monthly amount on both paid tiers', async () => {
    const { planSummary } = await import('../../../src/services/billing.js');
    const { PLANS } = await import('../../../src/models/plans.js');
    expect(planSummary(PLANS.garden, true).monthlyPrice).toBe(4.99);
    expect(planSummary(PLANS.greenhouse, true).monthlyPrice).toBe(9.99);
  });

  it('follows withdrawnIntervals, not the mere presence of a price', async () => {
    // A tier with an annual price and NO withdrawal publishes the amount; the
    // same tier with 'year' withdrawn publishes null. This pins the switch to
    // the flag, so re-listing a cadence is a one-line catalog change.
    const { planSummary } = await import('../../../src/services/billing.js');
    const { PLANS } = await import('../../../src/models/plans.js');
    const offered = { ...PLANS.garden, withdrawnIntervals: undefined };
    expect(planSummary(offered, true)).toMatchObject({ annualPrice: 39.99, lifetimePrice: 149 });
    const withdrawn = { ...PLANS.garden, withdrawnIntervals: ['year'] as const };
    expect(planSummary(withdrawn, true)).toMatchObject({ annualPrice: null, lifetimePrice: 149 });
  });

  it('omits every price field unless a caller explicitly enables them', async () => {
    const { planSummary } = await import('../../../src/services/billing.js');
    const { PLANS } = await import('../../../src/models/plans.js');
    expect(planSummary(PLANS.garden)).toEqual({
      id: 'garden',
      name: 'Garden',
      description: 'A household that has to coordinate',
      maxPlants: 200,
      maxMembers: null,
      limits: PLANS.garden.limits,
      features: PLANS.garden.features,
      // Entitlement, not a price: the client needs it to render a locked
      // control while prices are withheld (ADR 0018).
      householdToolkit: true,
    });
  });
});

describe('createCheckoutSession — interval resolves the Stripe price', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYMENTS_ENABLED = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_ID_GARDEN = 'price_garden_monthly';
    process.env.STRIPE_PRICE_ID_GARDEN_ANNUAL = 'price_garden_annual';
    process.env.STRIPE_PRICE_ID_GARDEN_LIFETIME = 'price_garden_lifetime';
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/cs' });
    seedCatalogPrices();
  });

  async function runCheckout(interval?: 'month' | 'year' | 'lifetime') {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // getHouseholdSubscription → no existing customer.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    return createCheckoutSession({
      householdId: 'hh-1',
      customerEmail: 'a@b.test',
      planId: 'garden',
      interval,
      successUrl: 's',
      cancelUrl: 'c',
    });
  }

  it.each([undefined, '', '0', 'true', '01', ' 1', '1 '])(
    'fails closed for PAYMENTS_ENABLED=%s before reading configuration or calling Stripe',
    async (value) => {
      if (value === undefined) delete process.env.PAYMENTS_ENABLED;
      else process.env.PAYMENTS_ENABLED = value;
      const { createCheckoutSession } = await import('../../../src/services/billing.js');
      await expect(
        createCheckoutSession({
          householdId: 'hh-1',
          customerEmail: 'a@b.test',
          planId: 'garden',
          interval: 'month',
          successUrl: 's',
          cancelUrl: 'c',
        })
      ).rejects.toMatchObject({ code: 'PAYMENTS_DISABLED' });
      expect(sessionsCreate).not.toHaveBeenCalled();
    }
  );

  it('uses the MONTHLY price id by default and stamps interval=month on metadata', async () => {
    const result = await runCheckout(undefined);
    expect(result.url).toBe('https://checkout.stripe.test/cs');
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_garden_monthly', quantity: 1 }],
        metadata: expect.objectContaining({ planId: 'garden', interval: 'month' }),
      })
    );
  });

  /*
   * PAYMENTS_ENABLED='1' is exercised below only with the shared status module
   * mocked inactive for retained-mechanics coverage. Production still requires
   * the root commercial-status decision to be inactive as well.
   */
  it('does not reach Stripe when the exact runtime gate is absent', async () => {
    delete process.env.PAYMENTS_ENABLED;
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    await expect(
      createCheckoutSession({
        householdId: 'hh-1',
        customerEmail: 'a@b.test',
        planId: 'garden',
        interval: 'month',
        successUrl: 's',
        cancelUrl: 'c',
      })
    ).rejects.toMatchObject({ code: 'PAYMENTS_DISABLED' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('forwards a checkout-attempt idempotency key to Stripe', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    await createCheckoutSession({
      householdId: 'hh-1',
      customerEmail: 'a@b.test',
      planId: 'garden',
      successUrl: 's',
      cancelUrl: 'c',
      idempotencyKey: 'checkout:hh-1:attempt-1',
    });

    expect(sessionsCreate).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: 'checkout:hh-1:attempt-1',
    });
  });

  it('enables automatic tax only when configured', async () => {
    process.env.STRIPE_AUTOMATIC_TAX_ENABLED = '1';
    try {
      await runCheckout('month');
      expect(sessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ automatic_tax: { enabled: true } })
      );
    } finally {
      delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
    }
  });

  // Withdrawn from sale 2026-09-02: Garden annual, Garden lifetime, and
  // Greenhouse annual. The service is the second line of defence behind the
  // handler's schema; it must refuse on the catalog's own rule — before it
  // reads price configuration, before it reads the household's billing row,
  // and long before it reaches Stripe. These calls deliberately queue NO
  // DynamoDB response: the guard has to throw before `dynamodb.send` runs,
  // and a queued-but-unconsumed mock would leak into the next test.
  async function attemptWithdrawnCheckout(
    planId: 'garden' | 'greenhouse',
    interval: 'year' | 'lifetime'
  ) {
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    return createCheckoutSession({
      householdId: 'hh-1',
      customerEmail: 'a@b.test',
      planId,
      interval,
      successUrl: 's',
      cancelUrl: 'c',
    });
  }

  it.each([
    ['garden', 'year'],
    ['garden', 'lifetime'],
    ['greenhouse', 'year'],
  ] as const)(
    'refuses the withdrawn %s/%s cadence before DynamoDB, configuration, or Stripe',
    async (planId, interval) => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      await expect(attemptWithdrawnCheckout(planId, interval)).rejects.toThrow(
        /^INTERVAL_WITHDRAWN:/
      );
      expect(dynamodb.send).not.toHaveBeenCalled();
      expect(sessionsCreate).not.toHaveBeenCalled();
    }
  );

  it('refuses a withdrawn cadence BEFORE reading price configuration', async () => {
    // With the annual env deleted, the old "Missing STRIPE_PRICE_ID_..."
    // error would fire if configuration were read first. The withdrawal
    // guard must win: the answer is "not sold", not "misconfigured".
    delete process.env.STRIPE_PRICE_ID_GARDEN_ANNUAL;
    const err = await attemptWithdrawnCheckout('garden', 'year').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^INTERVAL_WITHDRAWN:/);
    expect((err as Error).message).not.toMatch(/Missing STRIPE_PRICE_ID/);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('throws a clear error when the requested (offered) cadence has no configured price env', async () => {
    delete process.env.STRIPE_PRICE_ID_GARDEN;
    await expect(runCheckout('month')).rejects.toThrow('Missing STRIPE_PRICE_ID_GARDEN');
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('keeps mode=subscription (with subscription_data) for the monthly cadence', async () => {
    await runCheckout('month');
    const arg = sessionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.mode).toBe('subscription');
    expect(arg.subscription_data).toMatchObject({ trial_period_days: 14 });
  });
});

describe('existing annual and lifetime subscribers are untouched by the withdrawal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a renewing GARDEN ANNUAL subscription still resolves to the Garden tier and its caps', async () => {
    // The webhook resolves the tier from the price the subscription
    // carries. Withdrawal keeps the annual price env on the catalog for
    // exactly this reason: a renewal on the withdrawn cadence must keep
    // landing on the right tier, or the household loses its caps at the
    // first renewal after the change.
    process.env.STRIPE_PRICE_ID_GARDEN_ANNUAL = 'price_garden_annual';
    try {
      const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
      const { getPlan } = await import('../../../src/models/plans.js');
      const delta = deltaForStripeEvent({
        id: 'evt_renewal_annual',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_annual',
            status: 'active',
            metadata: { householdId: 'hh-1', planId: 'garden' },
            items: {
              data: [{ price: { id: 'price_garden_annual' }, current_period_end: 1_800_000_000 }],
            },
          },
        },
      } as unknown as Stripe.Event);
      expect(delta?.fields.planId).toBe('garden');
      expect(getPlan(delta?.fields.planId)).toMatchObject({
        limits: { plants: 200, members: null },
      });
    } finally {
      delete process.env.STRIPE_PRICE_ID_GARDEN_ANNUAL;
    }
  });

  it('a renewing GREENHOUSE ANNUAL subscription still resolves to the Greenhouse tier and its caps', async () => {
    process.env.STRIPE_PRICE_ID_GREENHOUSE_ANNUAL = 'price_gh_annual';
    try {
      const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
      const { getPlan } = await import('../../../src/models/plans.js');
      const delta = deltaForStripeEvent({
        id: 'evt_renewal_gh_annual',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_gh_annual',
            status: 'active',
            metadata: { householdId: 'hh-2', planId: 'greenhouse' },
            items: {
              data: [{ price: { id: 'price_gh_annual' }, current_period_end: 1_800_000_000 }],
            },
          },
        },
      } as unknown as Stripe.Event);
      expect(delta?.fields.planId).toBe('greenhouse');
      expect(getPlan(delta?.fields.planId)).toMatchObject({
        limits: { plants: 5000, members: null },
      });
    } finally {
      delete process.env.STRIPE_PRICE_ID_GREENHOUSE_ANNUAL;
    }
  });

  it('a household that already owns Garden for life keeps it: entitlement reads planId, not the offer', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { planId: 'garden', lifetimePlanId: 'garden', stripeCustomerId: 'cus_life' },
    });
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    const { getPlan } = await import('../../../src/models/plans.js');
    const sub = await getHouseholdSubscription('hh-life');
    expect(sub.planId).toBe('garden');
    expect(sub.lifetimePlanId).toBe('garden');
    expect(getPlan(sub.planId)).toMatchObject({ limits: { plants: 200, members: null } });
  });
});

describe('createCheckoutSession — refuses a second checkout for a household with a live subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYMENTS_ENABLED = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_ID_GARDEN = 'price_garden_monthly';
    process.env.STRIPE_PRICE_ID_GARDEN_LIFETIME = 'price_garden_lifetime';
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/cs' });
    seedCatalogPrices();
  });

  async function runWithExistingSub(status: string, interval?: 'month' | 'lifetime') {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: {
        planId: 'garden',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_existing',
        subscriptionStatus: status,
      },
    });
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    return createCheckoutSession({
      householdId: 'hh-1',
      customerEmail: 'a@b.test',
      planId: 'garden',
      interval,
      successUrl: 's',
      cancelUrl: 'c',
    });
  }

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused'])(
    'rejects a new recurring checkout when status is %s, without ever calling Stripe (prevents a second, concurrent subscription)',
    async (status) => {
      await expect(runWithExistingSub(status, 'month')).rejects.toThrow('ALREADY_SUBSCRIBED');
      expect(sessionsCreate).not.toHaveBeenCalled();
    }
  );

  async function runAsLifetimeOwner(
    planId: 'garden' | 'greenhouse',
    interval?: 'month' | 'lifetime'
  ) {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { planId: 'garden', stripeCustomerId: 'cus_1', lifetimePlanId: 'garden' },
    });
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    return createCheckoutSession({
      householdId: 'hh-1',
      customerEmail: 'a@b.test',
      planId,
      interval,
      successUrl: 's',
      cancelUrl: 'c',
    });
  }

  it('refuses to sell a tier the household already owns outright (monthly)', async () => {
    // A lifetime purchase has no subscription id, so the ALREADY_SUBSCRIBED
    // guard above cannot see it. Without this check the household would be
    // sold a Garden subscription that adds nothing to what it already owns
    // permanently. Monthly is the only Garden cadence still sold; the
    // lifetime cadence is refused earlier as withdrawn (see below).
    await expect(runAsLifetimeOwner('garden', 'month')).rejects.toThrow('LIFETIME_ALREADY_OWNED');
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('still allows a lifetime owner to upgrade to a strictly higher tier', async () => {
    // Lifetime is a floor, not a ceiling. The marker survives the upgrade, so
    // cancelling it later returns the household to Garden rather than seedling.
    process.env.STRIPE_PRICE_ID_GREENHOUSE = 'price_greenhouse_monthly';
    const result = await runAsLifetimeOwner('greenhouse', 'month');
    expect(result.url).toBe('https://checkout.stripe.test/cs');
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it('still allows checkout when the prior subscription is canceled (re-subscribing is fine)', async () => {
    const result = await runWithExistingSub('canceled', 'month');
    expect(result.url).toBe('https://checkout.stripe.test/cs');
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses the withdrawn lifetime cadence to a live subscriber as WITHDRAWN, before reading the household row', async () => {
    // Before 2026-09-02 a live monthly subscriber could convert to lifetime
    // (exempt from the ALREADY_SUBSCRIBED guard because the lifetime webhook
    // cancels the prior subscription — that exemption and its webhook half
    // are retained for a future re-listing, and the webhook side is tested
    // in the applyStripeEvent suite). Now that Garden lifetime is withdrawn,
    // the answer is "not sold", and it must come first: no DynamoDB read, no
    // Stripe call, and not the misleading "already subscribed" refusal.
    // Deliberately queues NO DynamoDB response, so the guard must throw
    // before `dynamodb.send` runs.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    const err = await createCheckoutSession({
      householdId: 'hh-1',
      customerEmail: 'a@b.test',
      planId: 'garden',
      interval: 'lifetime',
      successUrl: 's',
      cancelUrl: 'c',
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^INTERVAL_WITHDRAWN:/);
    expect((err as Error).message).not.toMatch(/ALREADY_SUBSCRIBED/);
    expect(dynamodb.send).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

describe('createPortalSession — shares the payment-activity gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    portalSessionsCreate.mockResolvedValue({ url: 'https://billing.stripe.test/portal' });
  });

  it.each([undefined, '', '0', 'true', '01', ' 1', '1 '])(
    'fails closed for PAYMENTS_ENABLED=%s before DynamoDB or Stripe',
    async (value) => {
      if (value === undefined) delete process.env.PAYMENTS_ENABLED;
      else process.env.PAYMENTS_ENABLED = value;
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { createPortalSession } = await import('../../../src/services/billing.js');

      await expect(createPortalSession('hh-1', 'https://app.test/settings')).rejects.toMatchObject({
        code: 'PAYMENTS_DISABLED',
      });
      expect(dynamodb.send).not.toHaveBeenCalled();
      expect(portalSessionsCreate).not.toHaveBeenCalled();
    }
  );

  it('creates a portal session only behind the exact runtime gate in mechanics tests', async () => {
    process.env.PAYMENTS_ENABLED = '1';
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { planId: 'garden', stripeCustomerId: 'cus_1' },
    });
    const { createPortalSession } = await import('../../../src/services/billing.js');

    await expect(createPortalSession('hh-1', 'https://app.test/settings')).resolves.toEqual({
      url: 'https://billing.stripe.test/portal',
    });
    expect(portalSessionsCreate).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: 'https://app.test/settings',
    });
  });
});

describe('getHouseholdSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to seedling when no record', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    // `trialAvailable` is part of the published shape (#602). A household with
    // no metadata row has consumed nothing, so the answer is a real `true`.
    expect(await getHouseholdSubscription('hh-1')).toEqual({
      planId: 'seedling',
      trialAvailable: true,
    });
  });

  it('never exposes the internal cancellation retry marker', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: {
        planId: 'garden',
        pendingStripeCancellationId: 'sub_private_retry_target',
      },
    });
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    expect(await getHouseholdSubscription('hh-1')).toEqual({
      planId: 'garden',
      stripeCustomerId: undefined,
      stripeSubscriptionId: undefined,
      status: undefined,
      currentPeriodEnd: undefined,
      trialAvailable: true,
    });
  });

  it('reads stored plan + Stripe ids', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: {
        planId: 'garden',
        stripeCustomerId: 'cus',
        stripeSubscriptionId: 'sub',
        subscriptionStatus: 'active',
      },
    });
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    const result = await getHouseholdSubscription('hh-1');
    expect(result.planId).toBe('garden');
    expect(result.stripeSubscriptionId).toBe('sub');
  });
});

describe('the free trial is once per household, not once per checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYMENTS_ENABLED = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_ID_GARDEN = 'price_garden_monthly';
    process.env.STRIPE_PRICE_ID_GARDEN_ANNUAL = 'price_garden_annual';
    process.env.STRIPE_PRICE_ID_GARDEN_LIFETIME = 'price_garden_lifetime';
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/cs' });
    seedCatalogPrices();
  });

  async function checkoutWithRow(Item: Record<string, unknown> | undefined) {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item });
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    await createCheckoutSession({
      householdId: 'hh-1',
      customerEmail: 'a@b.test',
      planId: 'garden',
      interval: 'month',
      successUrl: 's',
      cancelUrl: 'c',
    });
    return sessionsCreate.mock.calls[0][0] as {
      subscription_data?: { trial_period_days?: number };
    };
  }

  it('offers the 14-day trial to a household that has never had one', async () => {
    const params = await checkoutWithRow(undefined);
    expect(params.subscription_data?.trial_period_days).toBe(14);
  });

  it('does NOT offer a second trial once one has been consumed', async () => {
    // The defect: trial_period_days was unconditional, so cancel → re-checkout
    // minted a fresh 14 free days, indefinitely.
    const params = await checkoutWithRow({
      planId: 'seedling',
      subscriptionStatus: 'canceled',
      stripeCustomerId: 'cus_1',
      trialConsumedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(params.subscription_data?.trial_period_days).toBeUndefined();
    expect(params.subscription_data).toBeDefined();
  });

  it('still lets a canceled household re-subscribe — only the trial is once', async () => {
    // Re-subscribing after cancellation is deliberate (see the
    // ALREADY_SUBSCRIBED guard); the fix must not turn it into a refusal.
    const params = await checkoutWithRow({
      planId: 'seedling',
      subscriptionStatus: 'canceled',
      stripeCustomerId: 'cus_1',
      trialConsumedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(params.subscription_data).toBeDefined();
  });

  it('never exposes trialConsumedAt through the public subscription read', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { planId: 'garden', trialConsumedAt: '2026-01-01T00:00:00.000Z' },
    });
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    expect(await getHouseholdSubscription('hh-1')).not.toHaveProperty('trialConsumedAt');
  });

  // The trial guard was correct and invisible: nothing on the wire said the
  // trial was once per household, so the UI promised it unconditionally right
  // above the purchase button (#602). `trialAvailable` is the derived answer —
  // the date stays behind, the boolean goes out.
  it('publishes trialAvailable=false for a household that has consumed its trial', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { planId: 'seedling', trialConsumedAt: '2026-01-01T00:00:00.000Z' },
    });
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    const sub = await getHouseholdSubscription('hh-1');
    expect(sub.trialAvailable).toBe(false);
    // Still no timestamp: the client learns the answer, never the date.
    expect(sub).not.toHaveProperty('trialConsumedAt');
  });

  it('publishes trialAvailable=true for a household that has never had one', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { planId: 'seedling' } });
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    expect((await getHouseholdSubscription('hh-1')).trialAvailable).toBe(true);
  });

  it('publishes trialAvailable=true for a household with no metadata row at all', async () => {
    // The `if (!item) return { planId: 'seedling' }` path. A brand-new
    // household has consumed nothing, and answering `undefined` here would
    // make the client show the "already used it" wording to a first-time buyer.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    expect((await getHouseholdSubscription('hh-1')).trialAvailable).toBe(true);
  });

  /** The row a returning household has: cancelled, and its trial spent. */
  const RESUBSCRIBING_ROW = {
    planId: 'seedling' as const,
    subscriptionStatus: 'canceled',
    stripeCustomerId: 'cus_1',
    trialConsumedAt: '2026-01-01T00:00:00.000Z',
  };
  /** The same household before it ever had a trial. */
  const FIRST_TIME_ROW = {
    planId: 'seedling' as const,
    subscriptionStatus: 'canceled',
    stripeCustomerId: 'cus_1',
  };

  async function trialAvailableFor(Item: Record<string, unknown>) {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item });
    const { getHouseholdSubscription } = await import('../../../src/services/billing.js');
    return (await getHouseholdSubscription('hh-1')).trialAvailable;
  }

  // The published boolean and the checkout guard must never drift: the
  // sentence above the purchase button is only honest while it describes the
  // condition `createCheckoutSession` actually applies to the same row.
  it('agrees with the checkout guard when the trial is still available', async () => {
    const params = await checkoutWithRow(FIRST_TIME_ROW);
    expect(params.subscription_data?.trial_period_days).toBe(14);
    expect(await trialAvailableFor(FIRST_TIME_ROW)).toBe(true);
  });

  it('agrees with the checkout guard when the trial has been spent', async () => {
    const params = await checkoutWithRow(RESUBSCRIBING_ROW);
    expect(params.subscription_data?.trial_period_days).toBeUndefined();
    expect(await trialAvailableFor(RESUBSCRIBING_ROW)).toBe(false);
  });
});

describe('eventConsumesTrial / markTrialConsumed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recognizes a trialing subscription', async () => {
    const { eventConsumesTrial } = await import('../../../src/services/billing.js');
    expect(
      eventConsumesTrial({
        type: 'customer.subscription.created',
        data: { object: { status: 'trialing' } },
      } as unknown as Stripe.Event)
    ).toBe(true);
  });

  it('recognizes a subscription that has already converted OUT of its trial', async () => {
    // Stripe leaves trial_start/trial_end populated after conversion, so the
    // consumed trial stays visible even once the status is 'active'.
    const { eventConsumesTrial } = await import('../../../src/services/billing.js');
    expect(
      eventConsumesTrial({
        type: 'customer.subscription.updated',
        data: {
          object: { status: 'active', trial_start: 1_700_000_000, trial_end: 1_701_000_000 },
        },
      } as unknown as Stripe.Event)
    ).toBe(true);
  });

  it('recognizes a subscription checkout that required no payment', async () => {
    const { eventConsumesTrial } = await import('../../../src/services/billing.js');
    expect(
      eventConsumesTrial({
        type: 'checkout.session.completed',
        data: { object: { mode: 'subscription', payment_status: 'no_payment_required' } },
      } as unknown as Stripe.Event)
    ).toBe(true);
  });

  it('does not treat a paid subscription or a lifetime purchase as a trial', async () => {
    const { eventConsumesTrial } = await import('../../../src/services/billing.js');
    expect(
      eventConsumesTrial({
        type: 'customer.subscription.created',
        data: { object: { status: 'active' } },
      } as unknown as Stripe.Event)
    ).toBe(false);
    expect(
      eventConsumesTrial({
        type: 'checkout.session.completed',
        data: { object: { mode: 'payment', payment_status: 'paid' } },
      } as unknown as Stripe.Event)
    ).toBe(false);
    expect(
      eventConsumesTrial({
        type: 'customer.subscription.deleted',
        data: { object: { status: 'canceled' } },
      } as unknown as Stripe.Event)
    ).toBe(false);
  });

  it('writes the marker only when absent, so the first timestamp survives', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { markTrialConsumed } = await import('../../../src/services/billing.js');
    await markTrialConsumed('hh-1');
    const arg = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: { ConditionExpression: string; Key: Record<string, string> };
    };
    expect(arg.kind).toBe('Update');
    expect(arg.input.ConditionExpression).toBe('attribute_not_exists(#trialConsumedAt)');
    expect(arg.input.Key.PK).toBe('HOUSEHOLD#hh-1');
  });

  it('swallows the write-once conflict — a household keeps its FIRST trial date', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { markTrialConsumed } = await import('../../../src/services/billing.js');
    // mockReset (not just clear) so no queued or persistent implementation
    // from an earlier test can decide this one's outcome.
    vi.mocked(dynamodb.send).mockReset();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' })
    );
    await expect(markTrialConsumed('hh-1')).resolves.toBeUndefined();
  });

  it('re-throws a real write failure, so Stripe redelivers instead of losing the marker', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { markTrialConsumed } = await import('../../../src/services/billing.js');
    vi.mocked(dynamodb.send).mockReset();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('DDB throttled'));
    await expect(markTrialConsumed('hh-1')).rejects.toThrow('DDB throttled');
  });

  it('records consumption from the webhook, before anything the delta gates', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_trial',
      created: 1_700_000_000,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          status: 'trialing',
          metadata: { householdId: 'hh-1', planId: 'garden' },
        },
      },
    } as unknown as Stripe.Event);
    const first = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ConditionExpression?: string };
    };
    expect(first.input.ConditionExpression).toBe('attribute_not_exists(#trialConsumedAt)');
  });

  it('records consumption even for a checkout that grants nothing', async () => {
    // An `incomplete` trial checkout still burned the trial. If the marker
    // only rode along with a successful grant, the household could retry into
    // a fresh 14 days.
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_trial_unsettled',
      created: 1_700_000_000,
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          payment_status: 'no_payment_required',
          metadata: { householdId: 'hh-9', planId: 'garden' },
          customer: 'cus_9',
          subscription: 'sub_9',
        },
      },
    } as unknown as Stripe.Event);
    const kinds = vi
      .mocked(dynamodb.send)
      .mock.calls.map(
        (c) => (c[0] as unknown as { input: { ConditionExpression?: string } }).input
      );
    expect(kinds[0].ConditionExpression).toBe('attribute_not_exists(#trialConsumedAt)');
  });
});

describe('createCheckoutSession — refuses to charge an unreconciled price', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYMENTS_ENABLED = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_ID_GARDEN = 'price_garden_monthly';
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/cs' });
    seedCatalogPrices();
  });

  async function run() {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    const { createCheckoutSession } = await import('../../../src/services/billing.js');
    return createCheckoutSession({
      householdId: 'hh-1',
      customerEmail: 'a@b.test',
      planId: 'garden',
      interval: 'month',
      successUrl: 's',
      cancelUrl: 'c',
    });
  }

  it('reconciles the price it is about to charge before creating the Session', async () => {
    await run();
    expect(pricesRetrieve).toHaveBeenCalledWith('price_garden_monthly');
    expect(pricesRetrieve.mock.invocationCallOrder[0]).toBeLessThan(
      sessionsCreate.mock.invocationCallOrder[0]
    );
  });

  it('refuses when Stripe would charge an amount the catalog never published', async () => {
    // A transposed price id in tfvars: the UI says $4.99/mo, Stripe says
    // $79.99/yr. Nothing else in the stack compares the two.
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_garden_monthly',
      unit_amount: 7999,
      currency: 'usd',
      active: true,
      recurring: { interval: 'year', interval_count: 1 },
    });
    await expect(run()).rejects.toMatchObject({ code: 'PRICE_RECONCILIATION_FAILED' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the price cannot be retrieved at all', async () => {
    pricesRetrieve.mockRejectedValueOnce(new Error('Stripe unreachable'));
    await expect(run()).rejects.toMatchObject({ code: 'PRICE_RECONCILIATION_FAILED' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('refuses a foreign-currency price even when the digits match', async () => {
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_garden_monthly',
      unit_amount: 499,
      currency: 'gbp',
      active: true,
      recurring: { interval: 'month', interval_count: 1 },
    });
    await expect(run()).rejects.toMatchObject({ code: 'PRICE_RECONCILIATION_FAILED' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

describe('deltaForStripeEvent — a completed Session is not proof of payment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function session(over: Record<string, unknown>) {
    return {
      id: 'evt_sub',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          metadata: { householdId: 'hh-1', planId: 'garden' },
          customer: 'cus_1',
          subscription: 'sub_1',
          ...over,
        },
      },
    } as unknown as Stripe.Event;
  }

  it('grants an ACTIVE subscription when the first payment settled', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    expect(deltaForStripeEvent(session({ payment_status: 'paid' }))?.fields).toMatchObject({
      planId: 'garden',
      status: 'active',
      stripeSubscriptionId: 'sub_1',
    });
  });

  it('grants TRIALING, not active, when no payment was required', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    expect(
      deltaForStripeEvent(session({ payment_status: 'no_payment_required' }))?.fields
    ).toMatchObject({ planId: 'garden', status: 'trialing' });
  });

  it.each(['unpaid', 'no_payment_needed_typo', ''])(
    'grants NOTHING when payment_status is %s (the subscription is incomplete)',
    async (payment_status) => {
      // The defect: this stamped status 'active' unconditionally, so a
      // household whose card was declined got full paid caps immediately and
      // kept them until Stripe's dunning eventually canceled the subscription.
      const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
      expect(deltaForStripeEvent(session({ payment_status }))).toBeNull();
    }
  );

  it('grants nothing when the session reports no payment_status at all', async () => {
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    expect(deltaForStripeEvent(session({}))).toBeNull();
  });

  it('leaves the authoritative status to the subscription events', async () => {
    // Nothing is lost by refusing above: subscription_data carries the same
    // metadata, so customer.subscription.created arrives with the householdId
    // and Stripe's real status.
    const { deltaForStripeEvent } = await import('../../../src/services/billing.js');
    const delta = deltaForStripeEvent({
      id: 'evt_created',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          status: 'incomplete',
          metadata: { householdId: 'hh-1', planId: 'garden' },
        },
      },
    } as unknown as Stripe.Event);
    expect(delta?.fields.status).toBe('incomplete');
  });
});
