/**
 * A redeemed gift (ADR 0028) as the entitlement resolvers see it.
 *
 * Every assertion pins a value, because the defects this guards are wrong
 * values: a gift that never ends, a gift that lowers what a household already
 * has, a gift month metered at the free tier, and a gift that a Stripe status
 * silently switches off.
 */
import { describe, it, expect } from 'vitest';
import {
  featureOf,
  getEntitledPlan,
  getEntitledPlanForIssuedGrant,
  getMeteredPlanId,
  giftState,
  hasStripeEntitlementState,
  limitOf,
  noCardTrialState,
  type EntitlementSubscription,
} from '../../../src/models/plans.js';

const at = (s: string) => new Date(s);
const ENDS = '2026-12-13T14:00:00.000Z';
const DURING = '2026-11-01T00:00:00.000Z';
const AFTER = '2026-12-13T14:00:00.000Z';

const gifted: EntitlementSubscription = {
  planId: 'seedling',
  giftPlanId: 'greenhouse',
  giftEndsAt: ENDS,
};

describe('giftState', () => {
  it('is active before the end date, ended at it, and none without a gift', () => {
    expect(giftState(gifted, at(DURING))).toBe('active');
    expect(giftState(gifted, at('2026-12-13T13:59:59.999Z'))).toBe('active');
    expect(giftState(gifted, at(AFTER))).toBe('ended');
    expect(giftState({ planId: 'seedling' }, at(DURING))).toBe('none');
  });

  it('grants nothing for a gift that names no paid tier or an unreadable date', () => {
    expect(giftState({ giftPlanId: 'seedling', giftEndsAt: ENDS }, at(DURING))).toBe('none');
    expect(giftState({ giftPlanId: 'platinum', giftEndsAt: ENDS }, at(DURING))).toBe('none');
    expect(giftState({ giftPlanId: 'garden', giftEndsAt: 'soon' }, at(DURING))).toBe('none');
    expect(giftState({ giftPlanId: 'garden', giftEndsAt: '' }, at(DURING))).toBe('none');
  });

  it('is not Stripe state', () => {
    expect(hasStripeEntitlementState(gifted)).toBe(false);
  });
});

describe('a running gift raises entitlement to the gifted tier', () => {
  it('resolves a free household to the gifted tier, with its caps and features, while it runs', () => {
    const plan = getEntitledPlan(gifted, at(DURING));
    expect(plan.id).toBe('greenhouse');
    expect(limitOf(plan, 'homes')).toBeNull();
    expect(featureOf(plan, 'kiosk')).toBe(true);
    expect(getEntitledPlanForIssuedGrant(gifted, at(DURING)).id).toBe('greenhouse');
  });

  it('falls back to Seedling on the clock, with nothing else on the row', () => {
    expect(getEntitledPlan(gifted, at(AFTER)).id).toBe('seedling');
    expect(getEntitledPlanForIssuedGrant(gifted, at(AFTER)).id).toBe('seedling');
  });

  it('meters AI at the gifted tier, exactly as the paid plan — never at the free tier', () => {
    expect(getMeteredPlanId(gifted, at(DURING))).toBe('greenhouse');
    expect(getMeteredPlanId({ ...gifted, giftPlanId: 'garden' }, at(DURING))).toBe('garden');
    expect(getMeteredPlanId(gifted, at(AFTER))).toBe('seedling');
  });

  it('never lowers a household that already has more', () => {
    const greenhouseHousehold: EntitlementSubscription = {
      planId: 'greenhouse',
      status: 'active',
      stripeSubscriptionId: 'sub_1',
      giftPlanId: 'garden',
      giftEndsAt: ENDS,
    };
    expect(getEntitledPlan(greenhouseHousehold, at(DURING)).id).toBe('greenhouse');
    const lifetime: EntitlementSubscription = {
      planId: 'greenhouse',
      lifetimePlanId: 'greenhouse',
      giftPlanId: 'garden',
      giftEndsAt: ENDS,
    };
    expect(getEntitledPlan(lifetime, at(DURING)).id).toBe('greenhouse');
  });

  it('survives a Stripe subscription that is not in good standing: the gift was paid for', () => {
    const dunning: EntitlementSubscription = {
      planId: 'garden',
      status: 'past_due',
      stripeSubscriptionId: 'sub_1',
      giftPlanId: 'garden',
      giftEndsAt: ENDS,
    };
    expect(getEntitledPlan(dunning, at(DURING)).id).toBe('garden');
    expect(getEntitledPlan(dunning, at(AFTER)).id).toBe('seedling');
    const cancelled: EntitlementSubscription = {
      planId: 'seedling',
      status: 'canceled',
      giftPlanId: 'greenhouse',
      giftEndsAt: ENDS,
    };
    expect(getEntitledPlan(cancelled, at(DURING)).id).toBe('greenhouse');
  });

  it('sits on top of a lifetime floor and hands back to it when it ends', () => {
    const lifetimeGarden: EntitlementSubscription = {
      planId: 'garden',
      lifetimePlanId: 'garden',
      giftPlanId: 'greenhouse',
      giftEndsAt: ENDS,
    };
    expect(getEntitledPlan(lifetimeGarden, at(DURING)).id).toBe('greenhouse');
    expect(getEntitledPlan(lifetimeGarden, at(AFTER)).id).toBe('garden');
  });
});

describe('a running gift and the no-card trial', () => {
  const trialEnds = '2026-11-15T00:00:00.000Z';
  const both: EntitlementSubscription = {
    planId: 'seedling',
    noCardTrialEndsAt: trialEnds,
    giftPlanId: 'garden',
    giftEndsAt: ENDS,
  };

  it('the trial defers to the gift while the gift runs, so the gift month is metered at its own tier', () => {
    expect(noCardTrialState(both, at(DURING))).toBe('none');
    expect(getEntitledPlan(both, at(DURING)).id).toBe('garden');
    expect(getMeteredPlanId(both, at(DURING))).toBe('garden');
  });

  it('the trial is read again once the gift has ended', () => {
    // A gift shorter than the remaining trial: after it ends, the trial's own
    // clock decides. (Month-granular gifts make this rare, not impossible.)
    const shortGift: EntitlementSubscription = {
      ...both,
      giftEndsAt: '2026-11-10T00:00:00.000Z',
    };
    expect(noCardTrialState(shortGift, at('2026-11-12T00:00:00.000Z'))).toBe('active');
    expect(getMeteredPlanId(shortGift, at('2026-11-12T00:00:00.000Z'))).toBe('seedling');
    expect(noCardTrialState(shortGift, at('2026-11-16T00:00:00.000Z'))).toBe('ended');
  });
});
