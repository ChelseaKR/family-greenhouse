import { describe, expect, it } from 'vitest';
import {
  UNPAID_SUBSCRIPTION_STATUSES,
  isPaymentFailing,
  paymentFailedBodyKey,
  planWhilePaymentFails,
} from '@/features/billing/paymentFailing';
import type { SubscriptionState } from '@/services/billingService';

const sub = (overrides: Partial<SubscriptionState>): SubscriptionState => ({
  planId: 'garden',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  ...overrides,
});

describe('isPaymentFailing', () => {
  it.each(['past_due', 'unpaid', 'incomplete', 'incomplete_expired'])(
    'is true for the unpaid status %s',
    (status) => {
      expect(isPaymentFailing(sub({ status }))).toBe(true);
    }
  );

  it.each(['active', 'trialing', 'paused', 'canceled'])('is false for %s', (status) => {
    // `active`/`trialing` are paid; `paused` is deliberate, not a failure;
    // `canceled` is the end of dunning, not a card the household can still fix.
    expect(isPaymentFailing(sub({ status }))).toBe(false);
  });

  it('never reads an absent status, or no subscription at all, as a failed payment', () => {
    // checkout.session.completed records the subscription id before any status
    // arrives; that window is not dunning.
    expect(isPaymentFailing(sub({}))).toBe(false);
    expect(isPaymentFailing(sub({ status: '' }))).toBe(false);
    expect(isPaymentFailing(undefined)).toBe(false);
    expect(isPaymentFailing(null)).toBe(false);
  });

  it('is the exact complement of what the server entitles, among real Stripe statuses', () => {
    // backend/src/models/plans.ts ENTITLED_SUBSCRIPTION_STATUSES = active, trialing.
    // Everything Stripe can report is either entitled, unpaid, or one of the two
    // deliberate exclusions — nothing falls through unclassified.
    const stripeStatuses = [
      'active',
      'trialing',
      'past_due',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
      'canceled',
    ];
    const entitled = new Set(['active', 'trialing']);
    const excluded = new Set(['paused', 'canceled']);
    for (const status of stripeStatuses) {
      const classes = [
        entitled.has(status),
        UNPAID_SUBSCRIPTION_STATUSES.has(status),
        excluded.has(status),
      ].filter(Boolean);
      expect(classes, status).toHaveLength(1);
    }
  });
});

describe('planWhilePaymentFails', () => {
  it('falls to Seedling when nothing sits underneath the subscription', () => {
    expect(planWhilePaymentFails(sub({ status: 'past_due' }))).toBe('seedling');
    expect(planWhilePaymentFails(undefined)).toBe('seedling');
  });

  it('keeps a tier bought outright — the lifetime floor a declined card cannot remove', () => {
    expect(
      planWhilePaymentFails(
        sub({ planId: 'greenhouse', status: 'past_due', lifetimePlanId: 'garden' })
      )
    ).toBe('garden');
  });

  it('keeps a running gift, and ignores one that has ended', () => {
    const endsAt = '2027-01-01T00:00:00.000Z';
    expect(
      planWhilePaymentFails(
        sub({ status: 'unpaid', gift: { planId: 'greenhouse', endsAt, state: 'active' } })
      )
    ).toBe('greenhouse');
    expect(
      planWhilePaymentFails(
        sub({ status: 'unpaid', gift: { planId: 'greenhouse', endsAt, state: 'ended' } })
      )
    ).toBe('seedling');
  });

  it('takes the higher of a lifetime tier and a gift', () => {
    expect(
      planWhilePaymentFails(
        sub({
          status: 'past_due',
          lifetimePlanId: 'garden',
          gift: { planId: 'greenhouse', endsAt: '2027-01-01T00:00:00.000Z', state: 'active' },
        })
      )
    ).toBe('greenhouse');
  });
});

describe('paymentFailedBodyKey', () => {
  it('names the free plan only when the household actually falls to it', () => {
    expect(paymentFailedBodyKey(sub({ status: 'past_due' }))).toBe(
      'settings.billing.paymentFailedBody'
    );
    expect(paymentFailedBodyKey(sub({ status: 'past_due', lifetimePlanId: 'garden' }))).toBe(
      'settings.billing.paymentFailedBodyOwned'
    );
  });
});
