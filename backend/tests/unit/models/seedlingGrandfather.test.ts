import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GRANDFATHERED_SEEDLING_CAPS,
  HOUSEHOLD_CREATED_AT_UNKNOWN,
  PLANS,
  SEEDLING_LIMITS_CUT_AT,
  atCap,
  getEntitledPlan,
  getEntitledPlanForIssuedGrant,
  limitOf,
  planSummary,
  seedlingCapsGrandfathered,
  withSeedlingGrandfather,
} from '../../../src/models/plans.js';

/**
 * ADR 0040: Seedling was cut from 20 plants / 3 members to 8 / 2 on
 * 2026-10-23, and a household created before the cut keeps 20 and 3.
 */

const CUT_MS = Date.parse(SEEDLING_LIMITS_CUT_AT);
const BEFORE = new Date(CUT_MS - 1).toISOString();
const AT = SEEDLING_LIMITS_CUT_AT;
const AFTER = new Date(CUT_MS + 24 * 60 * 60 * 1000).toISOString();
// The real outside household over the new cap: 9 plants, 2 people, signed up 09-20.
const SEPTEMBER = '2026-09-20T18:00:00.000Z';

describe('the new free caps (ADR 0040)', () => {
  it('Seedling is 8 plants and 2 members in the catalog', () => {
    expect(PLANS.seedling.limits.plants).toBe(8);
    expect(PLANS.seedling.limits.members).toBe(2);
    expect(planSummary(PLANS.seedling)).toMatchObject({ maxPlants: 8, maxMembers: 2 });
  });

  it('the paid tiers did not move', () => {
    expect(PLANS.garden.monthlyPrice).toBe(4.99);
    expect(PLANS.greenhouse.monthlyPrice).toBe(9.99);
    expect(PLANS.garden.limits.plants).toBe(200);
    expect(PLANS.garden.limits.members).toBeNull();
    expect(PLANS.greenhouse.limits.plants).toBe(5000);
  });

  it('a household created after the cut is held to 8 and 2', () => {
    const plan = getEntitledPlan({ planId: 'seedling', householdCreatedAt: AFTER });
    expect(limitOf(plan, 'plants')).toBe(8);
    expect(limitOf(plan, 'members')).toBe(2);
    expect(atCap(8, limitOf(plan, 'plants'))).toBe(true);
    expect(atCap(2, limitOf(plan, 'members'))).toBe(true);
  });
});

describe('grandfathering by the household row’s createdAt (ADR 0040)', () => {
  it('keeps the September household at 20 plants and 3 members, with room for its 10th plant', () => {
    const plan = getEntitledPlan({ planId: 'seedling', householdCreatedAt: SEPTEMBER });
    expect(plan.id).toBe('seedling');
    expect(limitOf(plan, 'plants')).toBe(GRANDFATHERED_SEEDLING_CAPS.plants);
    expect(limitOf(plan, 'members')).toBe(GRANDFATHERED_SEEDLING_CAPS.members);
    expect(GRANDFATHERED_SEEDLING_CAPS).toEqual({ plants: 20, members: 3 });
    // 9 plants and 2 people: neither cap reached, so a 10th plant and a 3rd
    // person may still be added.
    expect(atCap(9, limitOf(plan, 'plants'))).toBe(false);
    expect(atCap(2, limitOf(plan, 'members'))).toBe(false);
    expect(atCap(3, limitOf(plan, 'members'))).toBe(true);
  });

  it('changes only the two cut caps: features and every other limit are Seedling’s', () => {
    const plan = getEntitledPlan({ planId: 'seedling', householdCreatedAt: SEPTEMBER });
    expect(plan.features).toEqual(PLANS.seedling.features);
    expect({ ...plan.limits, plants: 0, members: 0 }).toEqual({
      ...PLANS.seedling.limits,
      plants: 0,
      members: 0,
    });
    // The catalog object itself is untouched.
    expect(PLANS.seedling.limits.plants).toBe(8);
  });

  it('draws the line strictly before the cut', () => {
    expect(seedlingCapsGrandfathered(BEFORE)).toBe(true);
    expect(seedlingCapsGrandfathered(AT)).toBe(false);
    expect(seedlingCapsGrandfathered(AFTER)).toBe(false);
  });

  it('absent means no household row was read: the current caps apply', () => {
    expect(seedlingCapsGrandfathered(undefined)).toBe(false);
    expect(seedlingCapsGrandfathered(null)).toBe(false);
    expect(limitOf(getEntitledPlan({ planId: 'seedling' }), 'plants')).toBe(8);
  });

  it('a row with no readable createdAt is treated as created before the cut', () => {
    expect(seedlingCapsGrandfathered(HOUSEHOLD_CREATED_AT_UNKNOWN)).toBe(true);
    expect(seedlingCapsGrandfathered('not a date')).toBe(true);
  });

  it('never touches a paid tier, and comes back when a grandfathered household falls to Seedling', () => {
    const paying = getEntitledPlan({
      planId: 'garden',
      status: 'active',
      householdCreatedAt: SEPTEMBER,
    });
    expect(paying).toBe(PLANS.garden);
    const lapsed = getEntitledPlan({
      planId: 'garden',
      status: 'unpaid',
      householdCreatedAt: SEPTEMBER,
    });
    expect(lapsed.id).toBe('seedling');
    expect(limitOf(lapsed, 'plants')).toBe(20);
    const lapsedNew = getEntitledPlan({
      planId: 'garden',
      status: 'unpaid',
      householdCreatedAt: AFTER,
    });
    expect(limitOf(lapsedNew, 'plants')).toBe(8);
  });

  it('a running no-card trial is still Garden; at its end the household falls to ITS Seedling', () => {
    const endsAt = '2026-10-04T18:00:00.000Z';
    const trial = { planId: 'seedling', noCardTrialEndsAt: endsAt, householdCreatedAt: SEPTEMBER };
    expect(getEntitledPlan(trial, new Date('2026-10-01T00:00:00.000Z'))).toBe(PLANS.garden);
    const ended = getEntitledPlan(trial, new Date('2026-10-05T00:00:00.000Z'));
    expect(ended.id).toBe('seedling');
    expect(limitOf(ended, 'plants')).toBe(20);
  });

  it('both resolvers agree', () => {
    const sub = { planId: 'seedling', householdCreatedAt: SEPTEMBER };
    expect(limitOf(getEntitledPlanForIssuedGrant(sub), 'plants')).toBe(20);
    expect(limitOf(getEntitledPlanForIssuedGrant({ planId: 'seedling' }), 'plants')).toBe(8);
  });

  it('withSeedlingGrandfather returns one shared object, so identity checks stay cheap', () => {
    expect(withSeedlingGrandfather(PLANS.seedling, SEPTEMBER)).toBe(
      withSeedlingGrandfather(PLANS.seedling, BEFORE)
    );
    expect(withSeedlingGrandfather(PLANS.seedling, AFTER)).toBe(PLANS.seedling);
    expect(withSeedlingGrandfather(PLANS.greenhouse, SEPTEMBER)).toBe(PLANS.greenhouse);
  });
});

describe('the cutoff itself', () => {
  it('is in the past, so a household a test creates today is never grandfathered', () => {
    // A future cutoff would grandfather every fixture household created
    // "now" and turn the suite red on the day it passed.
    expect(CUT_MS).toBeLessThanOrEqual(Date.now());
  });

  it('is midnight Pacific on 2026-10-24, the date the Terms and help pages name', () => {
    const pacificDate = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(CUT_MS));
    expect(pacificDate).toBe('October 24, 2026');
    const pacificTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(CUT_MS));
    expect(pacificTime).toBe('00:00');

    const root = new URL('../../../../', import.meta.url);
    const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    // Moving the cutoff means moving these sentences: they state the date.
    expect(flat(read('frontend/src/i18n/locales/en/legal.json'))).toContain(
      `before ${pacificDate} keeps the free limits it signed up with, ${GRANDFATHERED_SEEDLING_CAPS.members} people and ${GRANDFATHERED_SEEDLING_CAPS.plants} plants`
    );
    expect(flat(read('frontend/src/i18n/locales/es/legal.json'))).toContain(
      `antes del 24 de octubre de 2026 conserva los límites gratuitos con los que se registró, ${GRANDFATHERED_SEEDLING_CAPS.members} personas y ${GRANDFATHERED_SEEDLING_CAPS.plants} plantas`
    );
    const help = flat(read('frontend/src/features/help/helpContent.tsx'));
    expect(help.split(`created before ${pacificDate}`).length - 1).toBe(4);
  });
});
