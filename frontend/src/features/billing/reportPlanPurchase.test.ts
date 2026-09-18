/**
 * What the GA4 `purchase` says for a plan checkout (reportPlanPurchase.ts).
 * The page-level behavior (once, only on a plan return, only when settled) is
 * in tests/unit/features/BillingSettings.test.tsx; this holds the decision.
 */
import { describe, expect, it } from 'vitest';
import type { Plan } from '@/services/billingService';
import { planPurchaseConversion, type PlanPurchaseInput } from './reportPlanPurchase';

/** The first 32 hex characters of SHA-256(source), computed outside the code
 *  under test (Python's hashlib), so the oracle is not the implementation. */
const SHA256_32: Record<string, string> = {
  sub_1: '13a076fce7d175418cc5f004c44c1061',
  'lifetime:hh-1:garden': 'edc76825f338c0f14537a3ae4b724182',
};
const order = (source: string) => SHA256_32[source];

const PLANS = [
  { id: 'garden', monthlyPrice: 4.99, annualPrice: 39.99, lifetimePrice: 149 },
  { id: 'greenhouse', monthlyPrice: 9.99, annualPrice: 79.99, lifetimePrice: null },
] as Plan[];

function input(over: Partial<PlanPurchaseInput>): PlanPurchaseInput {
  return {
    householdId: 'hh-1',
    subscription: {
      planId: 'greenhouse',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
    },
    plans: PLANS,
    plan: 'greenhouse',
    interval: 'month',
    ...over,
  };
}

describe('planPurchaseConversion', () => {
  it('prices a settled subscription from the catalog and names it by a hash', async () => {
    expect(await planPurchaseConversion(input({}))).toEqual({
      name: 'purchase',
      transactionId: order('sub_1'),
      plan: 'greenhouse',
      interval: 'month',
      value: 9.99,
    });
  });

  it('counts a card trial as the purchase of the plan it will bill', async () => {
    const trialing = input({
      subscription: { planId: 'garden', stripeSubscriptionId: 'sub_2', status: 'trialing' },
      plan: 'garden',
      interval: 'year',
    });
    expect(await planPurchaseConversion(trialing)).toMatchObject({ value: 39.99 });
  });

  it('names a lifetime purchase by its household and tier, never a Stripe id', async () => {
    const lifetime = input({
      subscription: { planId: 'garden', stripeCustomerId: 'cus_1', lifetimePlanId: 'garden' },
      plan: 'garden',
      interval: 'lifetime',
    });
    expect(await planPurchaseConversion(lifetime)).toEqual({
      name: 'purchase',
      transactionId: order('lifetime:hh-1:garden'),
      plan: 'garden',
      interval: 'lifetime',
      value: 149,
    });
  });

  it.each([
    ['nothing read yet', { subscription: undefined }],
    ['no subscription written yet', { subscription: { planId: 'seedling' as const } }],
    [
      'a subscription that is no longer live',
      {
        subscription: {
          planId: 'garden' as const,
          stripeSubscriptionId: 'sub_1',
          status: 'canceled',
        },
      },
    ],
    [
      'a lifetime return before the lifetime tier is recorded',
      {
        subscription: { planId: 'seedling' as const },
        plan: 'garden',
        interval: 'lifetime',
      },
    ],
  ])('waits while there is %s', async (_label, over) => {
    expect(await planPurchaseConversion(input(over as Partial<PlanPurchaseInput>))).toBeNull();
  });

  it.each([
    ['an address that names nothing', { plan: null, interval: null }],
    ['an address that names another plan', { plan: 'garden' }],
    ['an address with an unknown cadence', { interval: 'week' }],
    ['a catalog that withholds prices', { plans: undefined }],
  ])('still counts the purchase, without a value, for %s', async (_label, over) => {
    expect(await planPurchaseConversion(input(over))).toEqual({
      name: 'purchase',
      transactionId: order('sub_1'),
    });
  });
});
