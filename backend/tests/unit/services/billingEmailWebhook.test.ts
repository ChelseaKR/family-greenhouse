/**
 * Where the billing emails hook into the Stripe webhook — the two call sites
 * in `applyStripeEvent`, and the guarantee that the second one is downstream
 * of every guard that can decline an event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
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
vi.mock('../../../src/utils/serverAnalytics.js', () => ({ capture: vi.fn() }));
vi.mock('../../../src/config/commercialStatus.js', () => ({
  assertPaymentActivityAllowed: () => {},
}));
vi.mock('../../../src/services/billingEmails.js', () => ({ dispatchBillingEmails: vi.fn() }));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import { dispatchBillingEmails } from '../../../src/services/billingEmails.js';
import { applyStripeEvent } from '../../../src/services/billing.js';

interface FakeCommand {
  kind: string;
  input: { Key?: { PK?: string; SK?: string } };
}

/** Household row the METADATA Get resolves to. */
let householdRow: Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  householdRow = { planId: 'garden', stripeSubscriptionId: 'sub_1' };
  vi.mocked(dynamodb.send).mockImplementation((command: unknown) => {
    const cmd = command as FakeCommand;
    if (cmd.kind === 'Get') return Promise.resolve({ Item: householdRow }) as never;
    return Promise.resolve({}) as never;
  });
});

function stripeEvent(type: string, object: Record<string, unknown>): Stripe.Event {
  return {
    id: 'evt_hook',
    object: 'event',
    created: 1_756_000_000,
    livemode: false,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

const phases = () => vi.mocked(dispatchBillingEmails).mock.calls.map((call) => call[1]);

describe('applyStripeEvent — billing email dispatch', () => {
  it('runs the charge phase for an event that carries no subscription delta', async () => {
    // invoice.paid produces no delta, so without a dispatch before the
    // short-circuit no receipt would ever be sent.
    await applyStripeEvent(
      stripeEvent('invoice.paid', { customer: 'cus_1', currency: 'usd', amount_paid: 499 })
    );
    expect(phases()).toEqual(['charge']);
  });

  it('runs the charge phase before any branch, so a one-time purchase is receipted', async () => {
    await applyStripeEvent(
      stripeEvent('checkout.session.completed', {
        id: 'cs_1',
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 199,
        currency: 'usd',
        metadata: { householdId: 'hh-1', purchase: 'identify_top_up', credits: '20' },
      })
    );
    expect(vi.mocked(dispatchBillingEmails).mock.calls[0][1]).toBe('charge');
  });

  it('runs both phases, charge first, for an applied cancellation', async () => {
    await applyStripeEvent(
      stripeEvent('customer.subscription.deleted', {
        id: 'sub_1',
        metadata: { householdId: 'hh-1' },
        customer: 'cus_1',
      })
    );
    expect(phases()).toEqual(['charge', 'state_change']);
  });

  it('never sends a cancellation confirmation for a delivery it declined to apply', async () => {
    // The subscription-mismatch guard: the deleted subscription is not the one
    // this household references, so nothing is applied — and nothing may be
    // said about it either.
    householdRow = { planId: 'garden', stripeSubscriptionId: 'sub_other' };
    await applyStripeEvent(
      stripeEvent('customer.subscription.deleted', {
        id: 'sub_1',
        metadata: { householdId: 'hh-1' },
        customer: 'cus_1',
      })
    );
    expect(phases()).toEqual(['charge']);
  });

  it('never sends a cancellation confirmation for an out-of-order delivery', async () => {
    const conditionalFailure = new Error('conditional');
    conditionalFailure.name = 'ConditionalCheckFailedException';
    vi.mocked(dynamodb.send).mockImplementation((command: unknown) => {
      const cmd = command as FakeCommand;
      if (cmd.kind === 'Get') return Promise.resolve({ Item: householdRow }) as never;
      // The `lastStripeEventCreated` guard rejects the stale write.
      if (cmd.kind === 'Update') return Promise.reject(conditionalFailure) as never;
      return Promise.resolve({}) as never;
    });
    await applyStripeEvent(
      stripeEvent('customer.subscription.deleted', {
        id: 'sub_1',
        metadata: { householdId: 'hh-1' },
        customer: 'cus_1',
      })
    );
    expect(phases()).toEqual(['charge']);
  });
});
