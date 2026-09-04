import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sessionsCreate } = vi.hoisted(() => ({ sessionsCreate: vi.fn() }));
vi.mock('stripe', () => ({
  default: vi.fn(function () {
    return { checkout: { sessions: { create: sessionsCreate } } };
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
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

// Same runtime-gate stand-in the billing service tests use.
vi.mock('../../../src/config/commercialStatus.js', () => ({
  assertPaymentActivityAllowed: () => {
    if (process.env.PAYMENTS_ENABLED !== '1') {
      const error = new Error('Payment activity is disabled') as Error & { code?: string };
      error.code = 'PAYMENTS_DISABLED';
      throw error;
    }
  },
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';

const ARGS = {
  householdId: 'hh-1',
  customerEmail: 'a@b.test',
  successUrl: 's',
  cancelUrl: 'c',
};

describe('createIdentifyTopUpCheckoutSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYMENTS_ENABLED = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/topup' });
  });
  afterEach(() => {
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP;
    delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
  });

  it('fails closed on the payments gate before configuration, DynamoDB, or Stripe', async () => {
    delete process.env.PAYMENTS_ENABLED;
    const { createIdentifyTopUpCheckoutSession } =
      await import('../../../src/services/identifyTopUp.js');
    await expect(createIdentifyTopUpCheckoutSession(ARGS)).rejects.toMatchObject({
      code: 'PAYMENTS_DISABLED',
    });
    expect(dynamodb.send).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '  '])(
    'refuses with TOP_UP_NOT_CONFIGURED when the price env is %j — no fallback price, no Stripe call',
    async (value) => {
      if (value === undefined) delete process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP;
      else process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = value;
      const { createIdentifyTopUpCheckoutSession, TOP_UP_NOT_CONFIGURED } =
        await import('../../../src/services/identifyTopUp.js');
      await expect(createIdentifyTopUpCheckoutSession(ARGS)).rejects.toThrow(
        new RegExp(`^${TOP_UP_NOT_CONFIGURED}`)
      );
      expect(dynamodb.send).not.toHaveBeenCalled();
      expect(sessionsCreate).not.toHaveBeenCalled();
    }
  );

  it('opens a one-time (mode=payment) session for the configured price with the top-up marker stamped', async () => {
    // getHouseholdSubscription → no existing customer.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined } as never);
    const { createIdentifyTopUpCheckoutSession } =
      await import('../../../src/services/identifyTopUp.js');
    const result = await createIdentifyTopUpCheckoutSession(ARGS);
    expect(result).toEqual({ url: 'https://checkout.stripe.test/topup' });
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'payment',
      customer_email: 'a@b.test',
      line_items: [{ price: 'price_topup', quantity: 1 }],
      success_url: 's',
      cancel_url: 'c',
      client_reference_id: 'hh-1',
      metadata: {
        householdId: 'hh-1',
        purchase: 'identify_top_up',
        packId: 'identify-20',
        credits: '20',
      },
      automatic_tax: { enabled: false },
    });
    // Not a plan, not a cadence, not a subscription.
    expect(params.metadata).not.toHaveProperty('planId');
    expect(params.metadata).not.toHaveProperty('interval');
    expect(params).not.toHaveProperty('subscription_data');
    expect(params.customer).toBeUndefined();
  });

  it('reuses the household Stripe customer when one exists', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { planId: 'garden', stripeCustomerId: 'cus_1' },
    } as never);
    const { createIdentifyTopUpCheckoutSession } =
      await import('../../../src/services/identifyTopUp.js');
    await createIdentifyTopUpCheckoutSession(ARGS);
    expect(sessionsCreate.mock.calls[0][0]).toMatchObject({
      customer: 'cus_1',
      customer_update: { address: 'auto', name: 'auto' },
    });
    expect(sessionsCreate.mock.calls[0][0].customer_email).toBeUndefined();
  });

  it('forwards the per-click idempotency key to Stripe', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined } as never);
    const { createIdentifyTopUpCheckoutSession } =
      await import('../../../src/services/identifyTopUp.js');
    await createIdentifyTopUpCheckoutSession({ ...ARGS, idempotencyKey: 'top-up:hh-1:attempt-1' });
    expect(sessionsCreate).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: 'top-up:hh-1:attempt-1',
    });
  });

  it('enables automatic tax only when configured', async () => {
    process.env.STRIPE_AUTOMATIC_TAX_ENABLED = '1';
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined } as never);
    const { createIdentifyTopUpCheckoutSession } =
      await import('../../../src/services/identifyTopUp.js');
    await createIdentifyTopUpCheckoutSession(ARGS);
    expect(sessionsCreate.mock.calls[0][0].automatic_tax).toEqual({ enabled: true });
  });

  it('throws when Stripe returns no URL', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined } as never);
    sessionsCreate.mockResolvedValueOnce({ url: null });
    const { createIdentifyTopUpCheckoutSession } =
      await import('../../../src/services/identifyTopUp.js');
    await expect(createIdentifyTopUpCheckoutSession(ARGS)).rejects.toThrow(/checkout URL/);
  });
});
