import { describe, expect, it } from 'vitest';
import {
  PAYMENT_LAPSED_STATUSES,
  PAYMENT_RETRYING_STATUSES,
  isPaymentFailing,
  isPaymentLapsed,
  paymentFailedCopy,
  paymentFailureStage,
  planWhilePaymentFails,
} from '@/features/billing/paymentFailing';
import type { SubscriptionState } from '@/services/billingService';

const sub = (overrides: Partial<SubscriptionState>): SubscriptionState => ({
  planId: 'garden',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  ...overrides,
});

describe('paymentFailureStage', () => {
  it('calls past_due the retry window — the household keeps its plan (#593)', () => {
    expect(paymentFailureStage(sub({ status: 'past_due' }))).toBe('retrying');
    expect(isPaymentFailing(sub({ status: 'past_due' }))).toBe(true);
    expect(isPaymentLapsed(sub({ status: 'past_due' }))).toBe(false);
  });

  it.each(['unpaid', 'incomplete', 'incomplete_expired'])(
    'calls %s lapsed — the caps have dropped',
    (status) => {
      expect(paymentFailureStage(sub({ status }))).toBe('lapsed');
      expect(isPaymentFailing(sub({ status }))).toBe(true);
      expect(isPaymentLapsed(sub({ status }))).toBe(true);
    }
  );

  it.each(['active', 'trialing', 'paused', 'canceled'])('has nothing to say for %s', (status) => {
    // `active`/`trialing` are paid; `paused` is deliberate, not a failure;
    // `canceled` is the end of the subscription, not a card to fix.
    expect(paymentFailureStage(sub({ status }))).toBeNull();
    expect(isPaymentFailing(sub({ status }))).toBe(false);
  });

  it('never reads an absent status, or no subscription at all, as a failed payment', () => {
    expect(paymentFailureStage(sub({}))).toBeNull();
    expect(paymentFailureStage(sub({ status: '' }))).toBeNull();
    expect(paymentFailureStage(undefined)).toBeNull();
    expect(paymentFailureStage(null)).toBeNull();
  });

  it('mirrors the server: retrying is entitled, lapsed is not, and nothing is both', () => {
    // backend/src/models/plans.ts ENTITLED_SUBSCRIPTION_STATUSES =
    // active, trialing, past_due. Every status Stripe can report lands in
    // exactly one class, so no status falls through unclassified.
    const entitled = new Set(['active', 'trialing', 'past_due']);
    const excluded = new Set(['paused', 'canceled']);
    for (const status of [
      'active',
      'trialing',
      'past_due',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
      'canceled',
    ]) {
      const lapsed = PAYMENT_LAPSED_STATUSES.has(status);
      expect(
        [entitled.has(status), lapsed, excluded.has(status)].filter(Boolean),
        status
      ).toHaveLength(1);
      // The retry window is the one failure the server still entitles.
      if (PAYMENT_RETRYING_STATUSES.has(status)) expect(entitled.has(status), status).toBe(true);
    }
  });
});

describe('planWhilePaymentFails (the lapsed stage)', () => {
  it('falls to Seedling when nothing sits underneath the subscription', () => {
    expect(planWhilePaymentFails(sub({ status: 'unpaid' }))).toBe('seedling');
    expect(planWhilePaymentFails(undefined)).toBe('seedling');
  });

  it('keeps a tier bought outright — the lifetime floor a declined card cannot remove', () => {
    expect(
      planWhilePaymentFails(
        sub({ planId: 'greenhouse', status: 'unpaid', lifetimePlanId: 'garden' })
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
});

describe('paymentFailedCopy', () => {
  it('says the plan is kept while Stripe retries, naming it when the catalog can', () => {
    expect(paymentFailedCopy(sub({ status: 'past_due' }), 'Garden')).toEqual({
      titleKey: 'settings.billing.paymentRetryingTitle',
      bodyKey: 'settings.billing.paymentRetryingBody',
      values: { plan: 'Garden' },
    });
  });

  it('names no plan while retrying when the catalog could not name it', () => {
    expect(paymentFailedCopy(sub({ status: 'past_due' }), null)?.bodyKey).toBe(
      'settings.billing.paymentRetryingBodyNoPlan'
    );
  });

  it('never uses the retrying sentence once the payment has lapsed, and vice versa', () => {
    expect(paymentFailedCopy(sub({ status: 'unpaid' }), 'Garden')?.bodyKey).toBe(
      'settings.billing.paymentFailedBody'
    );
    expect(
      paymentFailedCopy(sub({ status: 'unpaid', lifetimePlanId: 'garden' }), 'Garden')?.bodyKey
    ).toBe('settings.billing.paymentFailedBodyOwned');
    expect(
      paymentFailedCopy(sub({ status: 'past_due', lifetimePlanId: 'garden' }), 'Garden')?.bodyKey
    ).toBe('settings.billing.paymentRetryingBody');
  });

  it('is null when there is no failed payment', () => {
    expect(paymentFailedCopy(sub({ status: 'active' }), 'Garden')).toBeNull();
    expect(paymentFailedCopy(undefined, 'Garden')).toBeNull();
  });
});
