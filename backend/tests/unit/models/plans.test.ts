import { describe, it, expect } from 'vitest';
import {
  PLANS,
  PLAN_ORDER,
  UNLIMITED,
  atCap,
  entitlementIsCurrent,
  getEntitledPlan,
  getEntitledPlanForIssuedGrant,
  getPlan,
  hasFeature,
  isPlanId,
  isIntervalOffered,
  isIntervalWithdrawn,
  isUnlimited,
  limitOf,
  planIncludesAwayKit,
  planRank,
  planSummary,
  hasHouseholdToolkit,
  strongestPlan,
  type Plan,
  type PlanFeatures,
  type PlanLimits,
} from '../../../src/models/plans.js';

const LIMIT_KEYS: Array<keyof PlanLimits> = [
  'homes',
  'members',
  'plants',
  'tags',
  'analyticsHistoryDays',
  'sitterLinkMaxDays',
  'sitterLinksActive',
];

const FEATURE_KEYS: Array<keyof PlanFeatures> = [
  'awayKit',
  'householdToolkit',
  'plantTags',
  'crossHomeToday',
  'kiosk',
  'caretakerSeats',
  'moveDay',
  'chat',
  'apiKeys',
];

describe('plan catalog (ADR 0014: the line is homes and hands)', () => {
  it('exposes exactly the three known tiers', () => {
    expect(Object.keys(PLANS).sort()).toEqual(['garden', 'greenhouse', 'seedling']);
  });

  it('pins the re-cut limits the handlers enforce', () => {
    expect(PLANS.seedling.limits).toEqual({
      homes: 1,
      members: 3,
      plants: 20,
      tags: 0,
      analyticsHistoryDays: 30,
      sitterLinkMaxDays: 7,
      sitterLinksActive: 1,
    });
    expect(PLANS.garden.limits).toEqual({
      homes: 1,
      members: null,
      plants: 200,
      tags: 50,
      analyticsHistoryDays: null,
      sitterLinkMaxDays: 90,
      sitterLinksActive: 10,
    });
    expect(PLANS.greenhouse.limits).toEqual({
      homes: null,
      members: null,
      plants: 5000,
      tags: null,
      analyticsHistoryDays: null,
      sitterLinkMaxDays: 90,
      sitterLinksActive: 25,
    });
  });

  it('the household toolkit (auto-handoff) is on both paid tiers and off on the free tier', () => {
    // ADR 0018: escalation is the paid layer on top of free claiming; rotation
    // is NOT behind this flag.
    expect(hasHouseholdToolkit(PLANS.seedling)).toBe(false);
    expect(hasHouseholdToolkit(PLANS.garden)).toBe(true);
    expect(hasHouseholdToolkit(PLANS.greenhouse)).toBe(true);
    // Published on the summary so the client can render a locked control
    // without hardcoding tier names.
    expect(planSummary(PLANS.seedling).householdToolkit).toBe(false);
    expect(planSummary(PLANS.garden).householdToolkit).toBe(true);
  });

  it('pins the capability map per tier', () => {
    expect(PLANS.seedling.features).toEqual({
      awayKit: false,
      householdToolkit: false,
      plantTags: false,
      crossHomeToday: false,
      kiosk: false,
      caretakerSeats: false,
      moveDay: false,
      chat: false,
      apiKeys: false,
    });
    expect(PLANS.garden.features).toEqual({
      awayKit: true,
      householdToolkit: true,
      plantTags: true,
      crossHomeToday: false,
      kiosk: false,
      caretakerSeats: false,
      moveDay: true,
      chat: true,
      apiKeys: false,
    });
    expect(PLANS.greenhouse.features).toEqual({
      awayKit: true,
      householdToolkit: true,
      plantTags: true,
      crossHomeToday: true,
      kiosk: true,
      caretakerSeats: true,
      moveDay: true,
      chat: true,
      apiKeys: true,
    });
  });

  it('every tier carries every limit key and every feature key (other domains read them by name)', () => {
    for (const plan of Object.values(PLANS)) {
      expect(Object.keys(plan.limits).sort()).toEqual([...LIMIT_KEYS].sort());
      expect(Object.keys(plan.features).sort()).toEqual([...FEATURE_KEYS].sort());
    }
  });

  it('never represents unlimited as Infinity — only as null', () => {
    for (const plan of Object.values(PLANS)) {
      for (const key of LIMIT_KEYS) {
        const value = plan.limits[key];
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
    }
    expect(UNLIMITED).toBeNull();
    // Survives the wire: what the client reads is exactly what the catalog says.
    expect(JSON.parse(JSON.stringify(PLANS.greenhouse.limits)).homes).toBeNull();
  });

  it('entitlement never goes DOWN the ladder on a limit', () => {
    // A higher tier may equal a lower one on a cap but never sit below it —
    // the whole point of the ladder. `null` (unlimited) is above any number.
    const rank = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY : v);
    for (const key of LIMIT_KEYS) {
      for (let i = 1; i < PLAN_ORDER.length; i++) {
        const lower = PLANS[PLAN_ORDER[i - 1]].limits[key];
        const higher = PLANS[PLAN_ORDER[i]].limits[key];
        expect(rank(higher)).toBeGreaterThanOrEqual(rank(lower));
      }
    }
    for (const key of FEATURE_KEYS) {
      for (let i = 1; i < PLAN_ORDER.length; i++) {
        const lower = PLANS[PLAN_ORDER[i - 1]].features[key];
        const higher = PLANS[PLAN_ORDER[i]].features[key];
        if (lower) expect(higher).toBe(true);
      }
    }
  });

  it('keeps the monthly prices exactly where they were (price changes are owner decisions)', () => {
    expect(PLANS.seedling.monthlyPrice).toBe(0);
    expect(PLANS.garden.monthlyPrice).toBe(4.99);
    expect(PLANS.greenhouse.monthlyPrice).toBe(9.99);
  });

  it('pins the sitter-link caps per tier (ADR 0015: free keeps one 7-day link; paid gets 90 days, several) and the plant-tag caps (ADR 0016: none free, 50 on Garden, unlimited above)', () => {
    // Asserted per key rather than as a whole-object `toEqual`: the re-cut
    // (ADR 0014) gave `limits` five more keys, so pinning the whole map here
    // would restate the block above instead of pinning what ADR 0015 and ADR
    // 0016 each decided.
    expect(PLANS.seedling.limits.sitterLinkMaxDays).toBe(7);
    expect(PLANS.seedling.limits.sitterLinksActive).toBe(1);
    expect(PLANS.garden.limits.sitterLinkMaxDays).toBe(90);
    expect(PLANS.garden.limits.sitterLinksActive).toBe(10);
    expect(PLANS.greenhouse.limits.sitterLinkMaxDays).toBe(90);
    expect(PLANS.greenhouse.limits.sitterLinksActive).toBe(25);
    expect(PLANS.seedling.limits.tags).toBe(0);
    expect(PLANS.garden.limits.tags).toBe(50);
    // Unlimited is the typed `null` of ADR 0014, never Infinity.
    expect(PLANS.greenhouse.limits.tags).toBeNull();
  });

  it('only paid tiers carry a Stripe price env var; free tier has none', () => {
    expect(PLANS.seedling.stripePriceEnv).toBeUndefined();
    expect(PLANS.garden.stripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN');
    expect(PLANS.greenhouse.stripePriceEnv).toBe('STRIPE_PRICE_ID_GREENHOUSE');
  });

  it('paid tiers carry an annual price + annual Stripe price env; free tier has neither', () => {
    expect(PLANS.seedling.annualPrice).toBeUndefined();
    expect(PLANS.seedling.annualStripePriceEnv).toBeUndefined();
    expect(PLANS.garden.annualPrice).toBe(39.99);
    expect(PLANS.garden.annualStripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN_ANNUAL');
    expect(PLANS.greenhouse.annualPrice).toBe(79.99);
    expect(PLANS.greenhouse.annualStripePriceEnv).toBe('STRIPE_PRICE_ID_GREENHOUSE_ANNUAL');
  });

  it('Garden alone carries a lifetime price + lifetime Stripe price env; other tiers have neither', () => {
    expect(PLANS.garden.lifetimePrice).toBe(149);
    expect(PLANS.garden.lifetimeStripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN_LIFETIME');
    expect(PLANS.seedling.lifetimePrice).toBeUndefined();
    expect(PLANS.seedling.lifetimeStripePriceEnv).toBeUndefined();
    expect(PLANS.greenhouse.lifetimePrice).toBeUndefined();
    expect(PLANS.greenhouse.lifetimeStripePriceEnv).toBeUndefined();
  });

  it('annual price is a genuine discount vs 12x the monthly price', () => {
    for (const id of ['garden', 'greenhouse'] as const) {
      const plan = PLANS[id];
      expect(plan.annualPrice).toBeDefined();
      expect(plan.annualPrice!).toBeLessThan(plan.monthlyPrice * 12);
    }
  });

  it('every plan id field matches its catalog key', () => {
    for (const [key, plan] of Object.entries(PLANS)) {
      expect(plan.id).toBe(key);
    }
  });

  it('names each tier by its story, not its collection size', () => {
    expect(PLANS.seedling.description).toBe('A couple and their plants');
    expect(PLANS.garden.description).toBe('A household that has to coordinate');
    expect(PLANS.greenhouse.description).toBe('Many homes, many hands');
  });
});

describe('the accessors every gate uses', () => {
  it('limitOf reads the named cap', () => {
    expect(limitOf(PLANS.seedling, 'members')).toBe(3);
    expect(limitOf(PLANS.garden, 'members')).toBeNull();
    expect(limitOf(PLANS.greenhouse, 'homes')).toBeNull();
  });

  it('isUnlimited is true only for null', () => {
    expect(isUnlimited(null)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(isUnlimited(5000)).toBe(false);
  });

  it('atCap answers "may one more be added?" as its negation', () => {
    expect(atCap(2, 3)).toBe(false);
    expect(atCap(3, 3)).toBe(true);
    expect(atCap(0, 0)).toBe(true);
  });

  it('atCap: an unlimited cap is never reached', () => {
    expect(atCap(0, null)).toBe(false);
    expect(atCap(1_000_000, null)).toBe(false);
  });

  it('atCap: a household ABOVE the cap is at cap (grandfathered: blocked on the next add, nothing else)', () => {
    // A free household with 6 members from before the re-cut, or a Garden
    // household with 300 plants: `atCap` is the only thing that consults the
    // count, and it only ever says "not one more". Nothing reads it to
    // reduce, delete, or hide.
    expect(atCap(6, 3)).toBe(true);
    expect(atCap(300, 200)).toBe(true);
  });

  it('hasFeature reads the named flag', () => {
    expect(hasFeature(PLANS.seedling, 'chat')).toBe(false);
    expect(hasFeature(PLANS.garden, 'chat')).toBe(true);
    expect(hasFeature(PLANS.garden, 'apiKeys')).toBe(false);
    expect(hasFeature(PLANS.greenhouse, 'apiKeys')).toBe(true);
    expect(hasFeature(PLANS.greenhouse, 'crossHomeToday')).toBe(true);
  });
});

describe('strongestPlan', () => {
  it('picks the highest-entitlement tier among several households', () => {
    expect(strongestPlan(['seedling', 'garden'])).toBe(PLANS.garden);
    expect(strongestPlan(['garden', 'greenhouse', 'seedling'])).toBe(PLANS.greenhouse);
  });

  it('treats unknown, null and undefined ids as the free tier', () => {
    expect(strongestPlan([undefined, null, 'enterprise'])).toBe(PLANS.seedling);
    expect(strongestPlan(['toString'])).toBe(PLANS.seedling);
  });

  it('is the free tier for no households at all', () => {
    expect(strongestPlan([])).toBe(PLANS.seedling);
  });
});

describe('getPlan', () => {
  it('returns the named plan for each valid id', () => {
    expect(getPlan('seedling')).toBe(PLANS.seedling);
    expect(getPlan('garden')).toBe(PLANS.garden);
    expect(getPlan('greenhouse')).toBe(PLANS.greenhouse);
  });

  it('falls back to the free tier for undefined, null, and empty string', () => {
    expect(getPlan(undefined)).toBe(PLANS.seedling);
    expect(getPlan(null)).toBe(PLANS.seedling);
    expect(getPlan('')).toBe(PLANS.seedling);
  });

  it('falls back to the free tier for unknown ids', () => {
    expect(getPlan('enterprise')).toBe(PLANS.seedling);
  });

  it("does NOT treat inherited prototype properties as plans ('toString' is not a plan)", () => {
    // Object.hasOwn, not `in`: `'toString' in PLANS` is true via the
    // prototype chain and would return undefined → crash the caller.
    expect(getPlan('toString')).toBe(PLANS.seedling);
    expect(getPlan('hasOwnProperty')).toBe(PLANS.seedling);
    expect(getPlan('constructor')).toBe(PLANS.seedling);
    expect(getPlan('__proto__')).toBe(PLANS.seedling);
  });
});

describe('isPlanId', () => {
  it('accepts exactly the catalog ids', () => {
    expect(isPlanId('seedling')).toBe(true);
    expect(isPlanId('garden')).toBe(true);
    expect(isPlanId('greenhouse')).toBe(true);
  });

  it('rejects unknown strings and prototype property names', () => {
    expect(isPlanId('enterprise')).toBe(false);
    expect(isPlanId('toString')).toBe(false);
    expect(isPlanId('__proto__')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isPlanId(undefined)).toBe(false);
    expect(isPlanId(null)).toBe(false);
    expect(isPlanId(42)).toBe(false);
    expect(isPlanId({ id: 'garden' })).toBe(false);
  });
});

describe('planSummary (what the client receives)', () => {
  it('publishes the full limits and features maps so the UI can gate without a second call', () => {
    const summary = planSummary(PLANS.garden);
    expect(summary.limits).toEqual(PLANS.garden.limits);
    expect(summary.features).toEqual(PLANS.garden.features);
    // Copies, not the catalog objects: a consumer mutating a summary must
    // not rewrite the source of truth.
    expect(summary.limits).not.toBe(PLANS.garden.limits);
    expect(summary.features).not.toBe(PLANS.garden.features);
  });

  it('keeps the legacy maxPlants / maxMembers fields, with null for unlimited', () => {
    expect(planSummary(PLANS.seedling)).toMatchObject({ maxPlants: 20, maxMembers: 3 });
    expect(planSummary(PLANS.garden)).toMatchObject({ maxPlants: 200, maxMembers: null });
    expect(planSummary(PLANS.greenhouse)).toMatchObject({ maxPlants: 5000, maxMembers: null });
  });

  it('publishes limits and features whether or not prices are included', () => {
    const withoutPrices = planSummary(PLANS.greenhouse);
    const withPrices = planSummary(PLANS.greenhouse, true);
    expect(withoutPrices.limits).toEqual(withPrices.limits);
    expect(withoutPrices.features).toEqual(withPrices.features);
    expect(withoutPrices.monthlyPrice).toBeUndefined();
    expect(withPrices.monthlyPrice).toBe(9.99);
  });
});

describe('withdrawn cadences (2026-09-02: annual on both paid tiers, Garden lifetime)', () => {
  it('pins exactly which cadences are withdrawn on each tier', () => {
    expect(PLANS.seedling.withdrawnIntervals).toBeUndefined();
    expect(PLANS.garden.withdrawnIntervals).toEqual(['year', 'lifetime']);
    expect(PLANS.greenhouse.withdrawnIntervals).toEqual(['year']);
  });

  it('offers monthly on both paid tiers and nothing else', () => {
    expect(isIntervalOffered(PLANS.garden, 'month')).toBe(true);
    expect(isIntervalOffered(PLANS.greenhouse, 'month')).toBe(true);
    expect(isIntervalOffered(PLANS.garden, 'year')).toBe(false);
    expect(isIntervalOffered(PLANS.garden, 'lifetime')).toBe(false);
    expect(isIntervalOffered(PLANS.greenhouse, 'year')).toBe(false);
    expect(isIntervalOffered(PLANS.greenhouse, 'lifetime')).toBe(false);
  });

  it('distinguishes "withdrawn" from "never existed"', () => {
    // Greenhouse lifetime was never a thing; Garden lifetime was, and is
    // withdrawn. Both are unoffered, but only one is a withdrawal — the
    // difference is what tells the webhook to keep resolving the price.
    expect(isIntervalWithdrawn(PLANS.garden, 'lifetime')).toBe(true);
    expect(isIntervalWithdrawn(PLANS.greenhouse, 'lifetime')).toBe(false);
    expect(isIntervalWithdrawn(PLANS.garden, 'month')).toBe(false);
    expect(isIntervalWithdrawn(PLANS.seedling, 'year')).toBe(false);
  });

  it("keeps every withdrawn cadence's price AND Stripe env on the catalog for existing subscribers", () => {
    // Withdrawal must not delete anything the webhook or the portal needs:
    // planIdFromPriceId maps a renewing annual/lifetime price id back to its
    // tier through these env names, so removing them would drop an existing
    // annual household to the free tier at its next renewal.
    expect(PLANS.garden.annualPrice).toBe(39.99);
    expect(PLANS.garden.annualStripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN_ANNUAL');
    expect(PLANS.garden.lifetimePrice).toBe(149);
    expect(PLANS.garden.lifetimeStripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN_LIFETIME');
    expect(PLANS.greenhouse.annualPrice).toBe(79.99);
    expect(PLANS.greenhouse.annualStripePriceEnv).toBe('STRIPE_PRICE_ID_GREENHOUSE_ANNUAL');
  });

  it('publishes a withdrawn cadence as null while still publishing monthly', () => {
    expect(planSummary(PLANS.garden, true)).toMatchObject({
      monthlyPrice: 4.99,
      annualPrice: null,
      lifetimePrice: null,
    });
    expect(planSummary(PLANS.greenhouse, true)).toMatchObject({
      monthlyPrice: 9.99,
      annualPrice: null,
      lifetimePrice: null,
    });
  });

  it('is switched by the flag, not by the presence of a price: clearing it re-offers the cadence', () => {
    const reListed: Plan = { ...PLANS.garden, withdrawnIntervals: [] };
    expect(isIntervalOffered(reListed, 'year')).toBe(true);
    expect(isIntervalOffered(reListed, 'lifetime')).toBe(true);
    expect(planSummary(reListed, true)).toMatchObject({ annualPrice: 39.99, lifetimePrice: 149 });
  });

  it('never offers a cadence the tier has no price for, withdrawn or not', () => {
    const noLifetime: Plan = { ...PLANS.greenhouse, withdrawnIntervals: [] };
    expect(isIntervalOffered(noLifetime, 'lifetime')).toBe(false);
  });
});

describe('household toolkit gate', () => {
  // The per-tier truth table is already pinned above ('the household toolkit
  // (auto-handoff) is ...'), which also checks the published summary. What is
  // NOT covered there is the unknown-id path, so that is what stays here.
  it('fails closed on an unknown plan id (resolves to the free tier)', () => {
    expect(hasHouseholdToolkit(getPlan('not-a-plan'))).toBe(false);
    expect(hasHouseholdToolkit(getPlan(undefined))).toBe(false);
  });
});

describe('Away Kit gate — the flag is the authority, not the rank (#605)', () => {
  // `features.awayKit` is published to every client by `planSummary`, and the
  // frontend gates on it: `AwayRecapPage` will not issue the recap query when
  // the flag is false. The server used to answer a DIFFERENT question of a
  // DIFFERENT value — `planRank(plan.id) >= planRank('garden')` — which agrees
  // with the flag on all three tiers that exist and would disagree, silently,
  // on a fourth. These cases are what "agree" means, stated so it can fail.

  it('answers exactly what the rank rule answered for every tier that exists — no behaviour change today', () => {
    for (const plan of Object.values(PLANS)) {
      expect(planIncludesAwayKit(plan)).toBe(planRank(plan.id) >= planRank('garden'));
    }
  });

  it('refuses a tier ranked ABOVE Garden whose flag is false — the grant-too-much direction', () => {
    // The tier a rank rule would hand the Away Kit to without being asked: a
    // high-plant-count tier with no sitter features, say.
    const highRankNoFlag: Plan = {
      ...PLANS.greenhouse,
      features: { ...PLANS.greenhouse.features, awayKit: false },
    };
    expect(planRank(highRankNoFlag.id)).toBeGreaterThan(planRank('garden'));
    expect(planIncludesAwayKit(highRankNoFlag)).toBe(false);
    // …and the client is told the same thing, which is the whole point.
    expect(planSummary(highRankNoFlag).features.awayKit).toBe(false);
  });

  it('grants a tier ranked BELOW Garden whose flag is true — the deny-too-much direction', () => {
    // The paired positive control. A gate that simply denied everyone would
    // pass the case above; nothing but reading the flag passes this one.
    const lowRankWithFlag: Plan = {
      ...PLANS.seedling,
      features: { ...PLANS.seedling.features, awayKit: true },
    };
    expect(planRank(lowRankWithFlag.id)).toBeLessThan(planRank('garden'));
    expect(planIncludesAwayKit(lowRankWithFlag)).toBe(true);
    expect(planSummary(lowRankWithFlag).features.awayKit).toBe(true);
  });

  it('the gate and the published flag never disagree, on any tier real or hypothetical', () => {
    for (const plan of Object.values(PLANS)) {
      for (const awayKit of [true, false]) {
        const candidate: Plan = { ...plan, features: { ...plan.features, awayKit } };
        expect(planIncludesAwayKit(candidate)).toBe(planSummary(candidate).features.awayKit);
      }
    }
  });

  it('fails closed on an unknown plan id (resolves to the free tier)', () => {
    expect(planIncludesAwayKit(getPlan('not-a-plan'))).toBe(false);
    expect(planIncludesAwayKit(getPlan(undefined))).toBe(false);
  });
});

describe('getEntitledPlan — caps follow payment status, not just planId', () => {
  it('grants the paid plan while Stripe reports the subscription active', () => {
    expect(getEntitledPlan({ planId: 'greenhouse', status: 'active' })).toBe(PLANS.greenhouse);
    expect(getEntitledPlan({ planId: 'garden', status: 'active' })).toBe(PLANS.garden);
  });

  it('grants the paid plan during the free trial — the trial IS the offer', () => {
    expect(getEntitledPlan({ planId: 'garden', status: 'trialing' })).toBe(PLANS.garden);
  });

  it.each(['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'])(
    'falls back to Seedling caps when the subscription is %s',
    (status) => {
      // The defect this pins: a household that has stopped paying kept full
      // paid caps for the whole of Stripe's dunning cycle, because caps were
      // resolved from planId alone. There is no published grace period, so
      // entitlement ends when good standing does.
      const plan = getEntitledPlan({ planId: 'greenhouse', status });
      expect(plan).toBe(PLANS.seedling);

      // The consequence, stated through the accessor the handlers actually
      // gate on. A household sitting exactly at the free ceiling may still
      // add on the plan row it is nominally on, and may not on the plan it is
      // entitled to. Every number is read from the catalog rather than
      // restated — the caps themselves are pinned once, above, and
      // Greenhouse's member cap is UNLIMITED (null), which is why this goes
      // through atCap instead of comparing.
      const freePlants = limitOf(PLANS.seedling, 'plants') as number;
      const freeMembers = limitOf(PLANS.seedling, 'members') as number;
      expect(atCap(freePlants, limitOf(PLANS.greenhouse, 'plants'))).toBe(false);
      expect(atCap(freeMembers, limitOf(PLANS.greenhouse, 'members'))).toBe(false);
      expect(atCap(freePlants, limitOf(plan, 'plants'))).toBe(true);
      expect(atCap(freeMembers, limitOf(plan, 'members'))).toBe(true);
    }
  );

  it('treats an unrecognized status as NOT entitled', () => {
    expect(getEntitledPlan({ planId: 'garden', status: 'something_new_from_stripe' })).toBe(
      PLANS.seedling
    );
  });

  it('keeps the plan when no subscription status was ever recorded', () => {
    // The lifetime grant and the free tier both live here. Revoking on absence
    // would take access from a household that paid.
    expect(getEntitledPlan({ planId: 'garden' })).toBe(PLANS.garden);
    expect(getEntitledPlan({ planId: 'garden', status: undefined })).toBe(PLANS.garden);
    expect(getEntitledPlan({ planId: 'garden', status: null })).toBe(PLANS.garden);
    expect(getEntitledPlan({ planId: 'garden', status: '' })).toBe(PLANS.garden);
  });

  it('never falls below a lifetime purchase, whatever the subscription status says', () => {
    // Regression: customer.subscription.deleted writes status 'canceled' and
    // applyStripeEvent restores planId to the lifetime tier without rewriting
    // the status, so resolving on status alone would revoke a $149 permanent
    // purchase the moment an unrelated subscription taken on top of it was
    // cancelled. A lifetime purchase is a FLOOR.
    expect(
      getEntitledPlan({ planId: 'garden', status: 'canceled', lifetimePlanId: 'garden' })
    ).toBe(PLANS.garden);
    expect(
      getEntitledPlan({ planId: 'seedling', status: 'unpaid', lifetimePlanId: 'garden' })
    ).toBe(PLANS.garden);
    // The floor lifts, it never caps: a live higher subscription still wins.
    expect(
      getEntitledPlan({ planId: 'greenhouse', status: 'active', lifetimePlanId: 'garden' })
    ).toBe(PLANS.greenhouse);
    // ...and an unpaid higher subscription drops to the floor, not past it.
    expect(
      getEntitledPlan({ planId: 'greenhouse', status: 'past_due', lifetimePlanId: 'garden' })
    ).toBe(PLANS.garden);
  });

  it('never resolves an unknown planId above the free tier', () => {
    expect(getEntitledPlan({ planId: 'enterprise', status: 'active' })).toBe(PLANS.seedling);
    expect(getEntitledPlan({ planId: 'toString', status: 'active' })).toBe(PLANS.seedling);
  });
});

describe('getEntitledPlanForIssuedGrant — starting vs continuing (#476)', () => {
  it('keeps the paid tier for a household mid-dunning, unlike getEntitledPlan', () => {
    // The whole point of the pair: the same subscription answers the two
    // questions differently. A sitter link already in someone's hands keeps
    // the Away Kit; minting a new one does not.
    for (const status of ['past_due', 'unpaid', 'incomplete', 'paused']) {
      expect(getEntitledPlanForIssuedGrant({ planId: 'garden', status })).toBe(PLANS.garden);
      expect(getEntitledPlan({ planId: 'garden', status })).toBe(PLANS.seedling);
    }
  });

  it('agrees with getEntitledPlan whenever the subscription is in good standing', () => {
    for (const status of ['active', 'trialing', undefined, null, '']) {
      const sub = { planId: 'greenhouse', status };
      expect(getEntitledPlanForIssuedGrant(sub)).toBe(getEntitledPlan(sub));
      expect(getEntitledPlanForIssuedGrant(sub)).toBe(PLANS.greenhouse);
    }
  });

  it('falls to the free tier once Stripe actually cancels, because planId is reset then', () => {
    // This is the bound on the leniency, and it is not a policy choice — it
    // is what applyStripeEvent writes on customer.subscription.deleted
    // (`fields: { planId: 'seedling', status: 'canceled' }`). Dunning is
    // weeks, not forever.
    expect(getEntitledPlanForIssuedGrant({ planId: 'seedling', status: 'canceled' })).toBe(
      PLANS.seedling
    );
  });

  it('still honours the lifetime floor', () => {
    expect(
      getEntitledPlanForIssuedGrant({
        planId: 'seedling',
        status: 'canceled',
        lifetimePlanId: 'garden',
      })
    ).toBe(PLANS.garden);
  });

  it('never resolves an unknown planId above the free tier', () => {
    expect(getEntitledPlanForIssuedGrant({ planId: 'enterprise' })).toBe(PLANS.seedling);
    expect(getEntitledPlanForIssuedGrant({ planId: 'toString' })).toBe(PLANS.seedling);
  });
});

describe('entitlementIsCurrent', () => {
  it('admits exactly active and trialing', () => {
    expect(entitlementIsCurrent('active')).toBe(true);
    expect(entitlementIsCurrent('trialing')).toBe(true);
    expect(entitlementIsCurrent('past_due')).toBe(false);
    expect(entitlementIsCurrent('unpaid')).toBe(false);
    expect(entitlementIsCurrent('incomplete')).toBe(false);
  });
});
