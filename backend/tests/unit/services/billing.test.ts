import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// Mock the Stripe SDK that billing.getStripe() dynamically imports, so
// createCheckoutSession can be exercised without a network/key. `sessionsCreate`
// is hoisted (vi.mock factories run before module init) and shared so tests can
// assert what was sent to Stripe.
const { sessionsCreate, subscriptionsCancel } = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  subscriptionsCancel: vi.fn(),
}));
vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return {
      checkout: { sessions: { create: sessionsCreate } },
      subscriptions: { cancel: subscriptionsCancel },
    };
  }),
}));

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
      },
    });
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
      data: { object: { metadata: { householdId: 'hh-1', planId: 'garden' }, customer: 'cus_1' } },
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
      data: { object: { metadata: { householdId: 'hh-1', planId: 'garden' }, customer: 'cus_1' } },
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
      data: { object: { metadata: { householdId: 'hh-1', planId: 'garden' }, customer: 'cus_1' } },
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

  it('does NOT emit on a cancellation/downgrade to seedling', async () => {
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
        object: { id: 'sub_live', metadata: { householdId: 'hh-1', planId: 'garden' } },
      },
    } as unknown as Stripe.Event);
    expect(captureMock).not.toHaveBeenCalled();
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

  it('emits on customer.subscription.created when it becomes active', async () => {
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
    expect(captureMock).toHaveBeenCalledWith('hh-1', 'subscription_activated', {
      plan: 'greenhouse',
      interval: 'month',
    });
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

describe('planSummary', () => {
  it('exposes annualPrice (null for the free tier, the dollar figure for paid tiers)', async () => {
    const { planSummary } = await import('../../../src/services/billing.js');
    const { PLANS } = await import('../../../src/models/plans.js');
    expect(planSummary(PLANS.seedling).annualPrice).toBeNull();
    expect(planSummary(PLANS.garden).annualPrice).toBe(39.99);
    expect(planSummary(PLANS.greenhouse).annualPrice).toBe(79.99);
  });

  it('exposes lifetimePrice (149 for Garden, null for tiers without a lifetime option)', async () => {
    const { planSummary } = await import('../../../src/services/billing.js');
    const { PLANS } = await import('../../../src/models/plans.js');
    expect(planSummary(PLANS.garden).lifetimePrice).toBe(149);
    expect(planSummary(PLANS.seedling).lifetimePrice).toBeNull();
    expect(planSummary(PLANS.greenhouse).lifetimePrice).toBeNull();
  });
});

describe('createCheckoutSession — interval resolves the Stripe price', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_ID_GARDEN = 'price_garden_monthly';
    process.env.STRIPE_PRICE_ID_GARDEN_ANNUAL = 'price_garden_annual';
    process.env.STRIPE_PRICE_ID_GARDEN_LIFETIME = 'price_garden_lifetime';
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/cs' });
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

  it('uses the ANNUAL price id when interval=year', async () => {
    await runCheckout('year');
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_garden_annual', quantity: 1 }],
        metadata: expect.objectContaining({ interval: 'year' }),
      })
    );
  });

  it('throws a clear error when the requested cadence has no configured price env', async () => {
    delete process.env.STRIPE_PRICE_ID_GARDEN_ANNUAL;
    await expect(runCheckout('year')).rejects.toThrow('Missing STRIPE_PRICE_ID_GARDEN_ANNUAL');
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('uses mode=payment + the lifetime price id and sends NO subscription_data when interval=lifetime', async () => {
    await runCheckout('lifetime');
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const arg = sessionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.mode).toBe('payment');
    expect(arg.line_items).toEqual([{ price: 'price_garden_lifetime', quantity: 1 }]);
    expect(arg.metadata).toMatchObject({ planId: 'garden', interval: 'lifetime' });
    // A one-time payment must NOT carry subscription_data / a trial.
    expect(arg.subscription_data).toBeUndefined();
  });

  it('keeps mode=subscription (with subscription_data) for the monthly/annual cadences', async () => {
    await runCheckout('month');
    const arg = sessionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.mode).toBe('subscription');
    expect(arg.subscription_data).toMatchObject({ trial_period_days: 14 });
  });
});

describe('createCheckoutSession — refuses a second checkout for a household with a live subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_ID_GARDEN = 'price_garden_monthly';
    process.env.STRIPE_PRICE_ID_GARDEN_LIFETIME = 'price_garden_lifetime';
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/cs' });
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

  it('still allows checkout when the prior subscription is canceled (re-subscribing is fine)', async () => {
    const result = await runWithExistingSub('canceled', 'month');
    expect(result.url).toBe('https://checkout.stripe.test/cs');
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it('exempts the lifetime cadence — its webhook already cancels any prior recurring subscription', async () => {
    const result = await runWithExistingSub('active', 'lifetime');
    expect(result.url).toBe('https://checkout.stripe.test/cs');
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params.mode).toBe('payment');
    expect(params.metadata).toMatchObject({ replacesSubscriptionId: 'sub_existing' });
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
    expect(await getHouseholdSubscription('hh-1')).toEqual({ planId: 'seedling' });
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
