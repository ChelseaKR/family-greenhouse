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

  it('does not apply a subscription update for a duplicate event', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const conditionErr = Object.assign(new Error('exists'), {
      name: 'ConditionalCheckFailedException',
    });
    // First send = the ledger PutCommand, which fails the condition (duplicate).
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditionErr);
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_dup',
      type: 'checkout.session.completed',
      data: { object: { metadata: { householdId: 'hh-1', planId: 'garden' } } },
    } as unknown as Stripe.Event);
    // Only the ledger write was attempted — no follow-up UpdateCommand.
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);
  });

  it('applies the subscription update for a first-seen event', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const { applyStripeEvent } = await import('../../../src/services/billing.js');
    await applyStripeEvent({
      id: 'evt_new',
      type: 'checkout.session.completed',
      data: { object: { metadata: { householdId: 'hh-1', planId: 'garden' }, customer: 'cus_1' } },
    } as unknown as Stripe.Event);
    // Ledger Put + subscription Update.
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(2);
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
