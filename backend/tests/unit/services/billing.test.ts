import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
  GetCommand: vi.fn((input) => ({ input, kind: 'Get' })),
  QueryCommand: vi.fn((input) => ({ input, kind: 'Query' })),
  DeleteCommand: vi.fn((input) => ({ input, kind: 'Delete' })),
  UpdateCommand: vi.fn((input) => ({ input, kind: 'Update' })),
  TransactWriteCommand: vi.fn((input) => ({ input, kind: 'TransactWrite' })),
  BatchWriteCommand: vi.fn((input) => ({ input, kind: 'BatchWrite' })),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
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
