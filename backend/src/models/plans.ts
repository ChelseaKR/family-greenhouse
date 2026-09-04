/**
 * Source-of-truth subscription plan catalog.
 *
 * The line between tiers is drawn on HOMES and HANDS, not on collection size
 * (ADR 0014): Seedling is "a couple and their plants", Garden is "a household
 * that has to coordinate", Greenhouse is "many homes, many hands". Each tier
 * names its `limits` and its `features` so the handlers can enforce them
 * without hardcoding numbers, and lists the Stripe price ID it maps to (read
 * at runtime from env so staging/prod keys stay separate). Free tier has no
 * Stripe price.
 *
 * Every cap gate reads through `limitOf` and compares through `atCap`; every
 * feature gate reads through `hasFeature`. Nothing compares a raw number, so
 * "unlimited" has exactly one representation (`null`, below) and exactly one
 * place where it is interpreted.
 *
 * Caps limit NEW GROWTH ONLY. A household already above a cap — a free
 * household with four members from before the re-cut, a Garden household
 * with 300 plants, a user in five homes — keeps everything it has. `atCap`
 * answers "may one more be added?", and the only thing an over-cap household
 * cannot do is add. Nothing is reduced, deleted, or hidden (ADR 0014, and the
 * Terms' "nothing is deleted when a plan changes").
 */
export type PlanId = 'seedling' | 'garden' | 'greenhouse';

/**
 * Billing cadence. The same `planId` (and therefore the same caps and
 * entitlements) is sold at each cadence — only the Stripe price and the
 * headline number differ — so the whole webhook/entitlement path stays
 * cadence-agnostic and resolves access off `planId` alone.
 *
 * `lifetime` is a one-time payment (Stripe `mode:'payment'`) rather than a
 * recurring subscription: it grants the same `planId` permanently with no
 * subscription to renew or cancel.
 */
export type BillingInterval = 'month' | 'year' | 'lifetime';

/**
 * A plan cap. A number is the ceiling; `null` is UNLIMITED — there is no
 * ceiling, so there is nothing to compare against.
 *
 * `null`, never `Infinity`: the catalog is published to the client as JSON,
 * and `JSON.stringify(Infinity)` is `null` anyway. Making that the typed,
 * documented representation means the server, the wire, and the client all
 * agree on one value instead of one of them getting it by accident.
 */
export type Limit = number | null;

/** The one spelling of "no ceiling". Compare with `isUnlimited`, not `===`. */
export const UNLIMITED: null = null;

/**
 * Per-tier caps. Other domains read these by NAME (the Away Kit, Plant Tags,
 * cross-home Today, the client's plan gating), so the keys are a contract:
 * add to them, never rename.
 */
export interface PlanLimits {
  /**
   * Households one USER may belong to. The only per-user cap in the catalog;
   * it is evaluated against the strongest plan the user would hold after the
   * action (`services/homesGate.ts`), so a Greenhouse household never turns
   * away a hand and a Greenhouse member may help at any number of homes.
   */
  homes: Limit;
  /** Members per household. */
  members: Limit;
  /** Active plants per household (archived / died / given away never count). */
  plants: Limit;
  /**
   * How many Plant Tags (ADR 0016) — printable QR labels — may be ACTIVE per
   * household. `0` means the feature is off for the tier; `null` (UNLIMITED)
   * means no ceiling. Read through `plantTagAllowance`, never compared
   * against directly.
   */
  tags: Limit;
  /**
   * Trailing window the analytics endpoints RENDER, in days. The data behind
   * it is never deleted or trimmed — only the window a request may ask for.
   */
  analyticsHistoryDays: Limit;
  /**
   * Longest sitter-link coverage window, in days (ADR 0015). Owned and
   * enforced by the Away Kit (`services/sitterPlanGate.ts`), which reads it
   * by name; `number`, not `Limit`, because every tier states a real ceiling.
   */
  sitterLinkMaxDays: number;
  /**
   * How many sitter links may be live (active or scheduled) at once (ADR
   * 0015). Owned and enforced by the Away Kit, same as the window above.
   */
  sitterLinksActive: number;
}

/**
 * Per-tier capability flags. Read by name from other domains exactly like
 * `PlanLimits`. A flag being `true` here says the TIER includes the feature;
 * whether the feature has shipped is the feature's own concern, so a public
 * surface must not advertise a flag it cannot point at working code for.
 */
export interface PlanFeatures {
  /** Sitter windows beyond 7 days, handoff brief, sitter photo-back, return recap. */
  awayKit: boolean;
  /**
   * Auto-handoff escalation, coverage view, double-care detection and
   * schedule-drift suggestions — signals only a shared household can
   * produce, served at $0 marginal cost. Care ROTATION is deliberately NOT
   * behind this flag (ADR 0018).
   */
  householdToolkit: boolean;
  /**
   * Plant Tags (ADR 0016): printable QR labels that let someone without an
   * account see a plant's last care and complete its due task. `limits.tags`
   * caps ACTIVE tags per household; this gates the surface. Read through
   * `plantTagAllowance`.
   */
  plantTags: boolean;
  /** One "what I owe today" list across every home, grouped by home. */
  crossHomeToday: boolean;
  /** Kiosk / wall-display link: a long-lived, read-mostly household token. */
  kiosk: boolean;
  /**
   * Caretaker seats: named, revocable, time-boxed, token-scoped identities a
   * household can hand to a paid helper, with proof-of-visit records. Token
   * scoped rather than Cognito users, so an active seat costs ~$0.001/month
   * (DynamoDB writes) rather than ~$0.06 (a Cognito MAU) — see
   * docs/adr/0020-token-scoped-caretaker-seats.md.
   */
  caretakerSeats: boolean;
  /** Seasonal Move Day (acts on summerSpaceId / winterSpaceId). */
  moveDay: boolean;
  /** The AI care assistant (services/chat). */
  chat: boolean;
  /** Public API keys (handlers/apiKeys, middleware/apiKey). */
  apiKeys: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** One-line tagline. The client renders its own translation keyed by `id`
   *  and falls back to this. */
  description: string;
  monthlyPrice: number; // dollars
  limits: PlanLimits;
  features: PlanFeatures;
  /** Env var name where the Stripe MONTHLY price ID lives. Read at runtime so
   *  staging/prod keys stay separate. Free tier has none. */
  stripePriceEnv?: string;
  /** Annual price in dollars/year (a discount vs 12× monthly). Undefined on the
   *  free tier. Present on every paid tier because households already on an
   *  annual subscription keep renewing at it; whether a NEW one may be started
   *  is `withdrawnIntervals`, not this field. */
  annualPrice?: number;
  /** Env var name where the Stripe ANNUAL price ID lives. Paired with
   *  `annualPrice`; absent on the free tier. */
  annualStripePriceEnv?: string;
  /** Lifetime price in dollars for a one-time payment that grants this tier's
   *  entitlement permanently. Modeled as a one-time billing interval on the
   *  existing tier (NOT a new planId), so entitlement resolution and the
   *  3-plan catalog stay unchanged. Only the Garden tier has one. */
  lifetimePrice?: number;
  /** Env var name where the Stripe LIFETIME (one-time) price ID lives. Paired
   *  with `lifetimePrice`; absent on tiers without a lifetime option. */
  lifetimeStripePriceEnv?: string;
  /**
   * Cadences that EXIST on this tier but may no longer be STARTED.
   *
   * Withdrawal is an availability decision, not a deletion. The price and its
   * Stripe env stay on the plan so that (a) the webhook can still resolve a
   * renewing annual/lifetime price id back to its tier, (b) the billing
   * portal keeps managing the subscriptions already on it, and (c)
   * entitlement — which reads `planId` alone — is untouched. What changes is
   * the OFFER: `planSummary` publishes `null` for a withdrawn cadence, which
   * the client already renders as "not available", and checkout refuses it
   * (`isIntervalOffered`). Stripe prices are never archived for this; the
   * subscriptions on them must keep renewing.
   *
   * Withdrawn 2026-09-02 (ADR 0012): at the verified per-ID cost the AI-cost
   * ceiling per household ($3.48 Garden, $7.58 Greenhouse) exceeds what an
   * annual subscription earns per month ($3.33 / $6.67), and a $149 lifetime
   * purchase is fully consumed after roughly 41 months. Monthly remains.
   * ADR 0014 records why the re-cut is the precondition for putting annual
   * back on sale, and leaves that as an open owner decision.
   */
  withdrawnIntervals?: readonly BillingInterval[];
}

/**
 * Monthly identification and leaf-health allowances are NOT here: they are
 * metered upstream-cost budgets owned by `services/identifyBudget.ts` and
 * `services/leafHealthBudget.ts` (per-environment, ADR 0012). The catalog
 * carries structural caps — things that cost nothing to serve.
 */
export const PLANS: Record<PlanId, Plan> = {
  seedling: {
    id: 'seedling',
    name: 'Seedling',
    description: 'A couple and their plants',
    monthlyPrice: 0,
    // Deliberately complete, not crippled. 20 plants (up from 10): plant rows
    // cost nothing, and generosity here buys member #2 — the metric that
    // matters. Three members: charge at the fourth hand, for what a
    // coordinating household then needs, never at the second.
    limits: {
      homes: 1,
      members: 3,
      plants: 20,
      tags: 0,
      analyticsHistoryDays: 30,
      // One live sitter link, a week long: the task list for a weekend away.
      sitterLinkMaxDays: 7,
      sitterLinksActive: 1,
    },
    features: {
      awayKit: false,
      householdToolkit: false,
      plantTags: false,
      crossHomeToday: false,
      kiosk: false,
      caretakerSeats: false,
      moveDay: false,
      chat: false,
      apiKeys: false,
    },
  },
  garden: {
    id: 'garden',
    name: 'Garden',
    description: 'A household that has to coordinate',
    monthlyPrice: 4.99,
    // ~33% off 12× monthly ($59.88) — "$3.33/mo billed yearly". Sits in the
    // competitive annual band ($30–48) the market actually pays at.
    annualPrice: 39.99,
    // One-time payment that grants Garden permanently. Stored as planId='garden'
    // with no subscription — entitlement resolves off planId alone.
    lifetimePrice: 149,
    // One home, unlimited hands. 200 plants (down from 500 for NEW growth
    // only — a Garden household already above 200 keeps every plant and is
    // simply not offered a 201st). 4,300 unused slots were never the reason
    // to buy; the toolkit is.
    // The Away Kit: windows to 90 days, several sitters at once (ADR 0015).
    limits: {
      homes: 1,
      members: UNLIMITED,
      plants: 200,
      tags: 50,
      analyticsHistoryDays: UNLIMITED,
      sitterLinkMaxDays: 90,
      sitterLinksActive: 10,
    },
    features: {
      awayKit: true,
      householdToolkit: true,
      plantTags: true,
      crossHomeToday: false,
      kiosk: false,
      caretakerSeats: false,
      moveDay: true,
      chat: true,
      apiKeys: false,
    },
    stripePriceEnv: 'STRIPE_PRICE_ID_GARDEN',
    annualStripePriceEnv: 'STRIPE_PRICE_ID_GARDEN_ANNUAL',
    lifetimeStripePriceEnv: 'STRIPE_PRICE_ID_GARDEN_LIFETIME',
    // Annual ($3.33/mo) and lifetime ($149 once) both earn less per month
    // than the tier's $3.48 AI-cost ceiling. Existing subscribers keep them.
    withdrawnIntervals: ['year', 'lifetime'],
  },
  greenhouse: {
    id: 'greenhouse',
    name: 'Greenhouse',
    description: 'Many homes, many hands',
    monthlyPrice: 9.99,
    // ~33% off 12× monthly ($119.88) — "$6.67/mo billed yearly".
    annualPrice: 79.99,
    // Many homes, many hands: the multi-home line IS the Greenhouse story.
    limits: {
      homes: UNLIMITED,
      members: UNLIMITED,
      plants: 5000,
      tags: UNLIMITED,
      analyticsHistoryDays: UNLIMITED,
      sitterLinkMaxDays: 90,
      sitterLinksActive: 25,
    },
    features: {
      awayKit: true,
      householdToolkit: true,
      plantTags: true,
      crossHomeToday: true,
      kiosk: true,
      caretakerSeats: true,
      moveDay: true,
      chat: true,
      apiKeys: true,
    },
    stripePriceEnv: 'STRIPE_PRICE_ID_GREENHOUSE',
    annualStripePriceEnv: 'STRIPE_PRICE_ID_GREENHOUSE_ANNUAL',
    // Annual ($6.67/mo) earns less per month than the tier's $7.58 AI-cost
    // ceiling. Existing subscribers keep it.
    withdrawnIntervals: ['year'],
  },
};

/** True when the tier includes the household toolkit (double-care, drift). */
export function hasHouseholdToolkit(plan: Plan): boolean {
  return plan.features.householdToolkit;
}

/**
 * True when the tier includes the Away Kit — the handoff brief (ADR 0015),
 * the sitter photo-back, and the return recap. One boundary, not three: the
 * free tier keeps the plain task list, and everything the Away Kit adds on
 * top starts at Garden. Expressed against PLAN_ORDER rather than a per-tier
 * flag so a future tier above Garden inherits it automatically, and so this
 * stays the single place the line is drawn — `sitterPlanGate` reads it too.
 */
export function planIncludesAwayKit(plan: Plan): boolean {
  return planRank(plan.id) >= planRank('garden');
}

export function getPlan(id: string | undefined | null): Plan {
  // Object.hasOwn (not `in`): `in` also matches inherited prototype
  // properties, so e.g. getPlan('toString') would return undefined and crash
  // the caller instead of falling back to the free tier.
  if (id && Object.hasOwn(PLANS, id)) return PLANS[id as PlanId];
  return PLANS.seedling;
}

/** Numeric caps for a tier; unknown ids fall back to the free tier's. */
export function planLimits(id: string | undefined | null): PlanLimits {
  return getPlan(id).limits;
}

/**
 * Tiers in ascending entitlement order. Used to compare what a household
 * already owns against what it is trying to buy — a lifetime purchase is an
 * entitlement FLOOR, so a tier at or below it must never be sold again.
 */
export const PLAN_ORDER: readonly PlanId[] = ['seedling', 'garden', 'greenhouse'];

/** Rank of a tier in PLAN_ORDER; higher means strictly more entitlement. */
export function planRank(id: PlanId): number {
  return PLAN_ORDER.indexOf(id);
}

/** Whether a tier switches on one feature. The single accessor every gate
 *  uses, so adding a tier can never silently miss a check. */
export function planHasFeature(
  id: string | undefined | null,
  feature: keyof PlanFeatures
): boolean {
  return getPlan(id).features[feature];
}

/**
 * True when membership in a household on this plan unlocks cross-home Today
 * (ADR 0017). The flag moved into `features` with the re-cut (ADR 0014); this
 * helper is the name the multi-home code reads it by, so its callers did not
 * have to move with it.
 */
export function planIncludesCrossHomeToday(plan: Plan): boolean {
  return plan.features.crossHomeToday;
}

/**
 * True when the tier includes Seasonal Move Day (brief §4.9). The flag moved
 * into `features` with the re-cut (ADR 0014), exactly like cross-home Today;
 * this helper is the name the climate code reads it by, so its callers did
 * not have to move with it.
 */
export function planHasMoveDay(plan: Plan): boolean {
  return plan.features.moveDay;
}

/** True iff `id` names a real plan in the catalog. */
export function isPlanId(id: unknown): id is PlanId {
  return typeof id === 'string' && Object.hasOwn(PLANS, id);
}

/**
 * The highest-entitlement plan among several plan ids (unknown ids count as
 * the free tier, like `getPlan`). An empty list is the free tier. This is how
 * a per-USER cap is resolved for someone who belongs to several households
 * on different plans: the strongest one they hold applies.
 */
export function strongestPlan(ids: Iterable<string | null | undefined>): Plan {
  let best = PLANS.seedling;
  for (const id of ids) {
    const plan = getPlan(id);
    if (planRank(plan.id) > planRank(best.id)) best = plan;
  }
  return best;
}

// ---------------------------------------------------------------------------
// The accessors every gate goes through
// ---------------------------------------------------------------------------

/** The cap for one dimension of a plan. `null` is unlimited. */
export function limitOf(plan: Plan, key: keyof PlanLimits): Limit {
  return plan.limits[key];
}

/** True when a limit has no ceiling. */
export function isUnlimited(limit: Limit): limit is null {
  return limit === null;
}

/**
 * "May one more be added?" — answered as its negation. True when `current`
 * has already reached `limit`, so adding one would exceed it; an unlimited
 * cap is never reached.
 *
 * This is the ONLY comparison a cap gate makes, and it is deliberately
 * `>=`: a household already ABOVE the cap (grandfathered, or downgraded) is
 * at cap too, which blocks the next add and nothing else. Reads, edits, and
 * removals never consult this function.
 */
export function atCap(current: number, limit: Limit): boolean {
  return limit !== null && current >= limit;
}

/** Whether the tier includes a capability. */
export function hasFeature(plan: Plan, key: keyof PlanFeatures): boolean {
  return plan.features[key];
}

/** True when this cadence exists on the tier but has been withdrawn from sale. */
export function isIntervalWithdrawn(plan: Plan, interval: BillingInterval): boolean {
  return plan.withdrawnIntervals?.includes(interval) ?? false;
}

/** Amount for a tier at one cadence, or undefined when the tier has no such cadence. */
function priceAt(plan: Plan, interval: BillingInterval): number | undefined {
  if (interval === 'lifetime') return plan.lifetimePrice;
  if (interval === 'year') return plan.annualPrice;
  return plan.monthlyPrice;
}

/**
 * True when a household may START this cadence today: the tier has a price
 * at it AND that cadence has not been withdrawn. This is the single authority
 * checkout consults, and `planSummary` publishes the same answer as a null
 * price — so a current client never shows an option the API would refuse,
 * and a stale or crafted request is refused on the same rule.
 */
export function isIntervalOffered(plan: Plan, interval: BillingInterval): boolean {
  return priceAt(plan, interval) !== undefined && !isIntervalWithdrawn(plan, interval);
}

/**
 * Plant Tags allowance for a plan (ADR 0016): whether the surface is on and
 * how many ACTIVE tags the household may hold. `max: null` means unlimited —
 * published that way because `Infinity` does not survive JSON, and since the
 * re-cut (ADR 0014) that is also how the catalog itself spells unlimited, so
 * this is now a pass-through rather than a conversion.
 */
export function plantTagAllowance(plan: Plan): { enabled: boolean; max: Limit } {
  return {
    enabled: plan.features.plantTags,
    max: limitOf(plan, 'tags'),
  };
}

export interface PlanSummary {
  id: PlanId;
  name: string;
  description: string;
  /** Legacy cap fields, kept so clients that predate `limits` keep rendering.
   *  Same values as `limits.plants` / `limits.members`; `null` is unlimited. */
  maxPlants: Limit;
  maxMembers: Limit;
  /** The full cap map, so the client can gate without a second call. */
  limits: PlanLimits;
  /** The capability map, likewise. */
  features: PlanFeatures;
  /** Legacy flag, kept for the same reason as `maxPlants`: clients that
   *  predate `features` read the toolkit by this name (ADR 0018's
   *  auto-handoff card). Same value as `features.householdToolkit`. */
  householdToolkit: boolean;
  monthlyPrice?: number;
  annualPrice?: number | null;
  lifetimePrice?: number | null;
}

/**
 * Public, client-facing projection of a plan. Price fields are fail-closed:
 * callers must explicitly prove that payments are available before including
 * them. The API and local server pass their commercial-status decision here,
 * while internal tests can still exercise the retained historical billing
 * implementation without publishing amounts. Limits and features are not
 * prices and are always published.
 */
export function planSummary(plan: Plan, includePrices = false): PlanSummary {
  const summary: PlanSummary = {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    maxPlants: plan.limits.plants,
    maxMembers: plan.limits.members,
    limits: { ...plan.limits },
    features: { ...plan.features },
    householdToolkit: plan.features.householdToolkit,
  };

  if (includePrices) {
    summary.monthlyPrice = plan.monthlyPrice;
    // null (not undefined) survives JSON serialization as an explicit
    // "no annual option" signal when payment activity is enabled. A WITHDRAWN
    // cadence publishes as null too — the same "not sold at this cadence"
    // signal the client already renders as "not available" — so a tier keeps
    // its annual/lifetime price for the households already on it without the
    // page offering it to new ones.
    summary.annualPrice = isIntervalOffered(plan, 'year') ? (plan.annualPrice ?? null) : null;
    summary.lifetimePrice = isIntervalOffered(plan, 'lifetime')
      ? (plan.lifetimePrice ?? null)
      : null;
  }

  return summary;
}
