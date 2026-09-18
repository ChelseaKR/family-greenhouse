/**
 * The no-card Garden trial (ADR 0027), as the entitlement resolvers see it.
 *
 * Every assertion pins a VALUE (a tier id, a state, a limit) rather than a
 * property, because the defects this guards are wrong values: a trial that
 * never ends, a trial handed to a household that never had one, and a trial
 * that changes what a household already on Stripe resolves to or spends.
 */
import { describe, it, expect } from 'vitest';
import {
  NO_CARD_TRIAL_DAYS,
  NO_CARD_TRIAL_METERING_PLAN_ID,
  NO_CARD_TRIAL_PLAN,
  featureOf,
  getEntitledPlan,
  getEntitledPlanForIssuedGrant,
  getMeteredPlanId,
  hasStripeEntitlementState,
  limitOf,
  noCardTrialState,
  type EntitlementSubscription,
} from '../../../src/models/plans.js';

const DAY = 24 * 60 * 60 * 1000;
// 23:30 UTC on the 20th, so the window crosses UTC midnights and a month
// boundary (September into October). A comparison on dates instead of
// instants, or on the month the trial started in, would show up here.
const CREATED = Date.parse('2026-09-20T23:30:00.000Z');
const ENDS_ISO = '2026-10-04T23:30:00.000Z';
const ENDS = Date.parse(ENDS_ISO);
const at = (ms: number) => new Date(ms);

/** A household created after the trial shipped: no Stripe state, trial on the row. */
const trial: EntitlementSubscription = { planId: 'seedling', noCardTrialEndsAt: ENDS_ISO };

describe('no-card trial: the constants are the decision', () => {
  it('is 14 days of Garden, metered at Seedling', () => {
    expect(NO_CARD_TRIAL_DAYS).toBe(14);
    expect(NO_CARD_TRIAL_PLAN.id).toBe('garden');
    expect(NO_CARD_TRIAL_METERING_PLAN_ID).toBe('seedling');
    expect(CREATED + NO_CARD_TRIAL_DAYS * DAY).toBe(ENDS);
  });
});

describe('no-card trial: runs for 14 days, then falls back on its own', () => {
  it.each([
    ['at creation', 'active', CREATED],
    ['one millisecond before the end', 'active', ENDS - 1],
    ['at the end instant', 'ended', ENDS],
    ['on day 15', 'ended', CREATED + 15 * DAY],
    ['a year later', 'ended', CREATED + 365 * DAY],
  ] as const)('%s the state is %s', (_label, state, now) => {
    expect(noCardTrialState(trial, at(now))).toBe(state);
  });

  it('grants Garden while it runs, and nothing above Garden', () => {
    const plan = getEntitledPlan(trial, at(ENDS - 1));
    expect(plan.id).toBe('garden');
    expect(limitOf(plan, 'plants')).toBe(200);
    expect(limitOf(plan, 'members')).toBeNull();
    expect(featureOf(plan, 'chat')).toBe(true);
    expect(featureOf(plan, 'awayKit')).toBe(true);
    expect(featureOf(plan, 'plantTags')).toBe(true);
    expect(featureOf(plan, 'householdToolkit')).toBe(true);
    expect(featureOf(plan, 'moveDay')).toBe(true);
    expect(featureOf(plan, 'caretakerSeats')).toBe(false);
    expect(featureOf(plan, 'kiosk')).toBe(false);
    expect(featureOf(plan, 'apiKeys')).toBe(false);
  });

  it('resolves to Seedling from the end instant on', () => {
    const plan = getEntitledPlan(trial, at(ENDS));
    expect(plan.id).toBe('seedling');
    expect(limitOf(plan, 'plants')).toBe(20);
    expect(limitOf(plan, 'members')).toBe(3);
    expect(featureOf(plan, 'chat')).toBe(false);
    expect(featureOf(plan, 'plantTags')).toBe(false);
  });

  it('issued grants follow the same window', () => {
    expect(getEntitledPlanForIssuedGrant(trial, at(CREATED + DAY)).id).toBe('garden');
    expect(getEntitledPlanForIssuedGrant(trial, at(ENDS)).id).toBe('seedling');
  });

  it('reads the real clock when no instant is passed', () => {
    const endsInAnHour = {
      planId: 'seedling',
      noCardTrialEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const endedAnHourAgo = {
      planId: 'seedling',
      noCardTrialEndsAt: new Date(Date.now() - 3_600_000).toISOString(),
    };
    expect(getEntitledPlan(endsInAnHour).id).toBe('garden');
    expect(getEntitledPlan(endedAnHourAgo).id).toBe('seedling');
  });
});

describe('no-card trial: AI spend is metered at Seedling', () => {
  it('while it runs, the metered tier is Seedling though the entitled tier is Garden', () => {
    const now = at(CREATED + DAY);
    expect(getEntitledPlan(trial, now).id).toBe('garden');
    expect(getMeteredPlanId(trial, now)).toBe('seedling');
  });

  it('after it ends, the metered tier is still Seedling', () => {
    expect(getMeteredPlanId(trial, at(ENDS))).toBe('seedling');
  });
});

describe('no-card trial: nobody has one who was not given one', () => {
  it.each([
    ['a household created before the trial existed', { planId: 'seedling' }],
    ['a row with no plan attribute at all', {}],
    ['an unreadable end date', { planId: 'seedling', noCardTrialEndsAt: 'not-a-date' }],
    ['an empty end date', { planId: 'seedling', noCardTrialEndsAt: '' }],
  ] as Array<[string, EntitlementSubscription]>)(
    '%s resolves to Seedling with no trial',
    (_label, sub) => {
      const now = at(CREATED + DAY);
      expect(noCardTrialState(sub, now)).toBe('none');
      expect(getEntitledPlan(sub, now).id).toBe('seedling');
      expect(getEntitledPlanForIssuedGrant(sub, now).id).toBe('seedling');
      expect(getMeteredPlanId(sub, now)).toBe('seedling');
    }
  );
});

/**
 * Households already on Stripe. The first row is the shape of the household
 * that has been on a card-based Garden trial since 2026-09-03 (ids synthetic).
 * Each row states what it resolves to and meters at, then the same row with
 * no-card trial attributes planted on it must resolve identically. If the trial
 * ever reached a Stripe household, the card-trial household's metered tier would
 * drop to Seedling (1 identification a month, a quarter of the chat budget), and
 * the cancelled one would be handed Garden.
 */
const STRIPE_HOUSEHOLDS: Array<[string, EntitlementSubscription, string, string]> = [
  [
    'Garden on a card-based Stripe trial (the 2026-09-03 household)',
    { planId: 'garden', status: 'trialing', stripeSubscriptionId: 'sub_synthetic_card_trial' },
    'garden',
    'garden',
  ],
  [
    'Garden, paid',
    { planId: 'garden', status: 'active', stripeSubscriptionId: 'sub_synthetic_paid' },
    'garden',
    'garden',
  ],
  [
    'Greenhouse, paid',
    { planId: 'greenhouse', status: 'active', stripeSubscriptionId: 'sub_synthetic_greenhouse' },
    'greenhouse',
    'greenhouse',
  ],
  [
    'Garden, unpaid after retries',
    { planId: 'garden', status: 'unpaid', stripeSubscriptionId: 'sub_synthetic_dunning' },
    'seedling',
    'seedling',
  ],
  [
    'cancelled and back on Seedling',
    { planId: 'seedling', status: 'canceled', stripeSubscriptionId: 'sub_synthetic_gone' },
    'seedling',
    'seedling',
  ],
  [
    'checkout completed, subscription status not yet recorded',
    { planId: 'garden', stripeSubscriptionId: 'sub_synthetic_gap' },
    'garden',
    'garden',
  ],
  [
    'Garden owned outright, a later subscription cancelled',
    { planId: 'seedling', status: 'canceled', lifetimePlanId: 'garden' },
    'garden',
    'garden',
  ],
];

describe('no-card trial: a household already on Stripe resolves exactly as it did before', () => {
  const now = at(CREATED + DAY);

  it.each(STRIPE_HOUSEHOLDS)('%s', (_label, sub, entitled, metered) => {
    expect(hasStripeEntitlementState(sub)).toBe(true);
    expect(noCardTrialState(sub, now)).toBe('none');
    expect(getEntitledPlan(sub, now).id).toBe(entitled);
    expect(getMeteredPlanId(sub, now)).toBe(metered);

    const planted: EntitlementSubscription = { ...sub, noCardTrialEndsAt: ENDS_ISO };
    expect(noCardTrialState(planted, now)).toBe('none');
    expect(getEntitledPlan(planted, now).id).toBe(entitled);
    expect(getEntitledPlanForIssuedGrant(planted, now).id).toBe(
      getEntitledPlanForIssuedGrant(sub, now).id
    );
    expect(getMeteredPlanId(planted, now)).toBe(metered);
  });

  it('a household with no Stripe state is not mistaken for one', () => {
    expect(hasStripeEntitlementState({ planId: 'seedling' })).toBe(false);
    expect(hasStripeEntitlementState({})).toBe(false);
    expect(hasStripeEntitlementState(trial)).toBe(false);
  });
});
