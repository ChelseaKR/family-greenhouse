import { api } from './api';
import { track } from './analytics';
import { COMMERCIAL_HOLD_ACTIVE, COMMERCIAL_HOLD_EFFECTIVE_DATE } from '@/config/commercialStatus';

export type PlanId = 'seedling' | 'garden' | 'greenhouse';

/**
 * A plan cap as the API publishes it (backend/src/models/plans.ts). A number
 * is the ceiling; `null` is UNLIMITED — a deliberate, typed value, never a
 * missing one. `undefined` (an older backend that did not send the field) is
 * "unknown", and must not be read as either.
 */
export type Limit = number | null;

/** Mirrors `PlanLimits` in backend/src/models/plans.ts — keys are a contract. */
export interface PlanLimits {
  homes: Limit;
  members: Limit;
  plants: Limit;
  tags: Limit;
  analyticsHistoryDays: Limit;
  sitterLinkMaxDays: Limit;
  sitterLinksActive: Limit;
}

/** Mirrors `PlanFeatures` in backend/src/models/plans.ts — keys are a contract. */
export interface PlanFeatures {
  awayKit: boolean;
  householdToolkit: boolean;
  plantTags: boolean;
  crossHomeToday: boolean;
  kiosk: boolean;
  caretakerSeats: boolean;
  moveDay: boolean;
  chat: boolean;
  apiKeys: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  /** Legacy caps; the same values as `limits.plants` / `limits.members`.
   *  `null` is unlimited (Garden and Greenhouse members). */
  maxPlants: Limit;
  maxMembers: Limit;
  /** The full cap map (ADR 0014). Absent only from an older backend, in
   *  which case the UI gates on the legacy fields and claims nothing more. */
  limits?: PlanLimits;
  /** The capability map, likewise. */
  features?: PlanFeatures;
  /** Price fields are present ONLY when the API reports paymentsAvailable —
   *  see planSummary() in backend/src/models/plans.ts, which omits them
   *  entirely while payment activity is disabled. `null` is the explicit
   *  "this tier has no such cadence" signal (free tier, or Greenhouse
   *  lifetime); `undefined` means prices are being withheld altogether. */
  monthlyPrice?: number;
  annualPrice?: number | null;
  lifetimePrice?: number | null;
  /** Household toolkit (auto-handoff etc.). Optional for rolling-deploy compatibility. */
  householdToolkit?: boolean;
}

/** Billing cadence accepted by POST /billing/checkout. */
export type BillingInterval = 'month' | 'year' | 'lifetime';

/**
 * The identification top-up pack offer (ADR 0019), published by
 * GET /billing/plans on the same fail-closed terms as the plan prices:
 * `available` is true only when payments are on AND the server has a Stripe
 * price configured; `priceUsd` is present only while payments are on.
 */
export interface IdentifyTopUpOffer {
  available: boolean;
  credits: number;
  validityDays: number;
  priceUsd?: number;
}

/** Identification credits a household holds. `expiresAt` is when the
 *  soonest-expiring pack with credits runs out; null when none remain. */
export interface IdentifyCreditBalance {
  remaining: number;
  expiresAt: string | null;
}

/**
 * The gift subscription offer (ADR 0028), published by GET /billing/plans on
 * the same fail-closed terms as the plan prices. The per-month amount is the
 * tier's `monthlyPrice` in `plans`; a gift costs that times the months, with
 * no discount. `available` per tier is true only when payments are on AND
 * the server has a Stripe price for that tier's gift month.
 */
export interface GiftSubscriptionOffer {
  minMonths: number;
  maxMonths: number;
  redeemWindowDays: number;
  plans: Array<{ planId: Exclude<PlanId, 'seedling'>; available: boolean }>;
}

/** A redeemed gift as GET /billing/me publishes it: state decided by the server's clock. */
export interface GiftState {
  planId: Exclude<PlanId, 'seedling'>;
  endsAt: string;
  state: 'active' | 'ended';
  /** Where the gift came from (ADR 0028 purchase vs ADR 0029 refer-a-friend).
   *  Display-only — entitlement (the caps a household actually gets) is the
   *  same either way. Absent on an older backend response reads as
   *  'purchase', the only source that could have produced a gift before
   *  referrals existed. */
  source?: 'purchase' | 'referral';
}

/** One gift this account bought, as GET /billing/gift/purchases lists it. */
export interface GiftPurchase {
  stripeSessionId: string;
  /** Display form, `FG-XXXX-XXXX-XXXX-XXXX`. */
  code: string;
  planId: Exclude<PlanId, 'seedling'>;
  months: number;
  purchasedAt: string;
  redeemBy: string;
  /** `unknown` means the server could not read whether it was redeemed. */
  status: 'unredeemed' | 'redeemed' | 'expired' | 'unknown';
  redeemedAt: string | null;
  giftEndsAt: string | null;
}

export interface PlanCatalog {
  paymentsAvailable: boolean;
  commercialHold: {
    active: boolean;
    effectiveDate: string;
  };
  plans: Plan[];
  /** Absent from older backends. */
  identifyTopUp?: IdentifyTopUpOffer;
  /** Absent from older backends. */
  giftSubscriptions?: GiftSubscriptionOffer;
}

/** Legacy usage shape from GET /billing/me: counters are always numeric here;
 *  a cap is `null` when the plan has no ceiling on it. */
export interface PlanUsage {
  plantCount: number;
  maxPlants: Limit;
  memberCount: number;
  maxMembers: Limit;
}

/** Nullable usage shape for counters that may be unseeded or unavailable.
 *  A null COUNTER is "unknown"; a null CAP is "unlimited" — two different
 *  fields, two different meanings, never conflated. */
export interface PlanUsageDetail {
  plantCount: number | null;
  maxPlants: Limit;
  memberCount: number | null;
  maxMembers: Limit;
}

export interface SubscriptionState {
  planId: PlanId;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  status?: string;
  currentPeriodEnd?: string;
  /** Tier owned permanently via a one-time purchase. Distinct from every
   *  other field here, which describes a subscription — a lifetime purchase
   *  has none, so this is the only durable record that the household already
   *  paid for this tier outright. */
  lifetimePlanId?: PlanId;
  /** Cancelled, but the paid period has not elapsed yet. `status` stays
   *  active/trialing throughout, so this is the only signal that the plan is
   *  ending — without it a cancellation is invisible in the UI. */
  cancelAtPeriodEnd?: boolean;
  /** Whether a NEW subscription checkout for this household would include the
   *  14-day free trial. The trial is once per household, not once per
   *  checkout, so a household that had one before and resubscribes is charged
   *  at once. `undefined` is UNKNOWN — an older backend, or a response cached
   *  before the field existed — and must never be read as `false`; go through
   *  `resolveTrialOffer`, which keeps the three states apart. */
  trialAvailable?: boolean;
  /** Legacy shape: present only when both counters are known. */
  usage?: PlanUsage;
  /** Additive nullable shape. Older backends do not send it. */
  usageDetail?: PlanUsageDetail;
  /** Identification top-up credits. `null` means the balance could not be
   *  read — unknown, never zero. Absent from older backends. */
  identifyCredits?: IdentifyCreditBalance | null;
  /** The household's no-card Garden trial (ADR 0027). `null` means there is
   *  none to describe: the household never had one, or Stripe owns its
   *  entitlement. Absent from older backends. */
  noCardTrial?: NoCardTrial | null;
  /** A redeemed gift subscription (ADR 0028). `null` means none to describe.
   *  Absent from older backends. */
  gift?: GiftState | null;
  /** A plan Checkout Session this household was handed and never finished,
   *  old enough that the backend calls it abandoned rather than merely
   *  in-flight (`backend/src/services/billing.ts`'s `PENDING_CHECKOUT_WINDOW_MS`).
   *  Absent — not present, never `null` — whenever there is nothing to say:
   *  no marker, one still fresh (the purchase button stays withheld by
   *  `awaitingEntitlement`/`hasLiveSubscription` elsewhere, not by this),
   *  or an undated one an operator edited by hand. Absent from older
   *  backends too. See `StaleCheckout` for what it does and does not prove. */
  staleCheckout?: StaleCheckout;
}

/**
 * `SubscriptionState.staleCheckout` as GET /billing/me publishes it.
 *
 * `startedAt` is when the abandoned Session was handed out, not when it went
 * stale; there is no plan id here (the row never recorded which tier the
 * checkout was for), so copy built on this must describe "a plan", not name
 * one.
 *
 * Does NOT prove with certainty that nothing was, or will be, charged: a
 * Checkout Session that used a payment method settling later (e.g. a bank
 * debit) can still turn into a real charge well after this fact starts being
 * true — see the field's backend doc comment. Treat it as "abandoned" in the
 * overwhelming ordinary case, not as a payment guarantee.
 */
export interface StaleCheckout {
  startedAt: string;
}

/**
 * The no-card Garden trial as GET /billing/me publishes it (ADR 0027). `state`
 * is decided by the SERVER's clock; `endsAt` is for display and countdowns.
 */
export interface NoCardTrial {
  state: 'active' | 'ended';
  endsAt: string;
}

const PLAN_RANK: Record<PlanId, number> = { seedling: 0, garden: 1, greenhouse: 2 };

/**
 * The tier whose FEATURES this household may use now, for the client-side
 * gates that show or hide a feature. It is `planId` for every household except
 * one on a running no-card trial, which gets Garden's (ADR 0027); the server
 * answers the same question in `getEntitledPlan`, and this only keeps the UI
 * from hiding what the API allows.
 *
 * `planId` stays the plan the household is ON, and Settings → Billing keeps
 * reading it: a trial household is on Seedling, trying Garden.
 */
export function effectivePlanId(subscription?: SubscriptionState | null): PlanId | null {
  if (!subscription) return null;
  const { planId } = subscription;
  let effective: PlanId = planId ?? 'seedling';
  // A running gift raises the household to the gifted tier (ADR 0028), the
  // way the server's `giftState` does; it never lowers it.
  if (
    subscription.gift?.state === 'active' &&
    (PLAN_RANK[effective] ?? PLAN_RANK.seedling) < (PLAN_RANK[subscription.gift.planId] ?? 0)
  ) {
    effective = subscription.gift.planId;
  }
  if (
    subscription.noCardTrial?.state === 'active' &&
    (PLAN_RANK[effective] ?? PLAN_RANK.seedling) < PLAN_RANK.garden
  ) {
    effective = 'garden';
  }
  return planId === undefined && effective === 'seedling' ? null : effective;
}

/**
 * Whether this household's next subscription would start with the free trial.
 *
 * Three states, not two, for the same reason `PlanLimitState` has three: a
 * missing `trialAvailable` is not evidence that the trial is gone. Reading
 * `undefined` as "used" would tell a first-time buyer on an older backend that
 * they are about to be charged when they are not, which is the mirror image of
 * the defect this exists to fix — so `unknown` is its own answer and gets its
 * own sentence, one that is true whichever way the real state falls.
 */
export type TrialOffer = 'available' | 'used' | 'unknown';

export function resolveTrialOffer(subscription?: SubscriptionState | null): TrialOffer {
  if (subscription?.trialAvailable === true) return 'available';
  if (subscription?.trialAvailable === false) return 'used';
  return 'unknown';
}

/** Prefer the nullable contract, with rolling-deploy fallback to legacy usage. */
export function resolvePlanUsage(
  subscription?: SubscriptionState | null
): PlanUsageDetail | undefined {
  return subscription?.usageDetail ?? subscription?.usage;
}

/**
 * Where a household sits against one plan cap. `unknown` is a first-class
 * answer and is deliberately NOT collapsed into `within`: an unreadable
 * counter is not evidence that the household is under its limit, and a
 * boolean cannot hold that difference (#308).
 */
export type PlanLimitState = 'within' | 'over' | 'unknown';

export interface PlanLimitEvaluation {
  plants: PlanLimitState;
  members: PlanLimitState;
  /**
   * The state to speak to the user: a known overage outranks an unknown
   * counter (it is actionable), and `unknown` outranks `within` (we cannot
   * claim they are inside their caps while a counter is missing).
   */
  overall: PlanLimitState;
}

function limitState(count: number | null | undefined, max: Limit): PlanLimitState {
  // No ceiling means nothing can be over it, whatever the counter says — and
  // `count > null` would otherwise coerce to `count > 0`, reporting every
  // Garden household with a member as "over".
  if (max === null) return 'within';
  if (typeof count !== 'number' || !Number.isFinite(count)) return 'unknown';
  return count > max ? 'over' : 'within';
}

/**
 * Evaluate the household against its plan caps — only breached after a
 * downgrade (or an admin-side plan change). Existing data stays
 * readable/editable; only adding is blocked server-side.
 *
 * Each dimension is evaluated independently, so an unknown member count
 * neither manufactures a warning nor hides a known plant overage.
 */
export function evaluatePlanLimits(usage?: PlanUsageDetail | null): PlanLimitEvaluation {
  if (!usage) {
    // No usage in the response at all (older backend, or still loading). We
    // know nothing, and say so rather than implying compliance.
    return { plants: 'unknown', members: 'unknown', overall: 'unknown' };
  }
  const plants = limitState(usage.plantCount, usage.maxPlants);
  const members = limitState(usage.memberCount, usage.maxMembers);
  const overall: PlanLimitState =
    plants === 'over' || members === 'over'
      ? 'over'
      : plants === 'unknown' || members === 'unknown'
        ? 'unknown'
        : 'within';
  return { plants, members, overall };
}

/**
 * A read, in the three settled states ADR 0010 requires — the same vocabulary
 * as `useSpaces` (#534) and `CoverageCard` (#417). `unavailable` means the
 * read SETTLED without data: not "there is none", and never a default.
 */
export type ReadOutcome = 'loading' | 'ready' | 'unavailable';

/**
 * Map a react-query result onto those three states.
 *
 * `pending` is deliberately NOT synonymous with `loading`. A disabled query
 * (`enabled: false`, so `fetchStatus === 'idle'`) stays pending forever and
 * nothing further is coming: it has settled without data, which is
 * `unavailable`. Calling that `loading` is how "we never looked" gets rendered
 * as an answer — the exact collapse that told a paying household it was on the
 * free tier when its active household id had not resolved.
 */
export function readOutcome(query: {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
}): ReadOutcome {
  if (query.status === 'error') return 'unavailable';
  if (query.status === 'success') return 'ready';
  return query.fetchStatus === 'idle' ? 'unavailable' : 'loading';
}

/**
 * Which plan the household is on — a settled three-state read, because
 * "we could not check" is an answer and "Seedling" is a claim.
 *
 * Two independent reads back the sentence "Your household is on the X plan":
 * the SUBSCRIPTION supplies the tier and the CATALOG supplies that tier's
 * name. Both are required before the claim may be made. Every earlier
 * fallback here defaulted to the free tier
 * (`?? 'seedling'`, `?? 'Seedling'`, `?? []`), so a failed read told a
 * household paying $9.99/mo that it was on the free plan — stated as fact, on
 * the one screen it would visit to check exactly that.
 */
export interface CurrentPlanRead {
  status: ReadOutcome;
  /** The tier the SUBSCRIPTION actually returned. Never a default. */
  planId: PlanId | null;
  /**
   * That tier's name as the CATALOG published it. Non-null only when
   * `status === 'ready'`: a name is never invented, capitalised from an id, or
   * borrowed from another tier.
   */
  planName: string | null;
  /** The read settled without an answer. Never true while it is in flight. */
  unavailable: boolean;
}

export function resolveCurrentPlan(input: {
  subscription: ReadOutcome;
  subscriptionData?: SubscriptionState;
  catalog: ReadOutcome;
  plans?: Plan[];
}): CurrentPlanRead {
  const { subscription, catalog, subscriptionData, plans } = input;
  if (subscription === 'loading' || catalog === 'loading') {
    return { status: 'loading', planId: null, planName: null, unavailable: false };
  }
  // Only a settled-successful subscription read may supply the tier. An
  // errored one supplies nothing — not the free tier.
  const planId = subscription === 'ready' ? (subscriptionData?.planId ?? null) : null;
  const planName =
    planId !== null && catalog === 'ready'
      ? (plans?.find((p) => p.id === planId)?.name ?? null)
      : null;
  if (planId === null || planName === null) {
    // `planId` is kept when we have it: a caller may honestly name a tier the
    // subscription really returned, even when the catalog could not name it.
    // It is never enough on its own to assert which plan the household is on.
    return { status: 'unavailable', planId, planName: null, unavailable: true };
  }
  return { status: 'ready', planId, planName, unavailable: false };
}

export const billingService = {
  async listPlans(): Promise<PlanCatalog> {
    const response = await api.get<PlanCatalog | Plan[]>('/billing/plans');
    if (Array.isArray(response.data)) {
      // Rolling-deploy compatibility: the prior API returned a bare array with
      // price fields. Strip it to the noncommercial plan projection and fail
      // closed until the new status-bearing API is live.
      return {
        paymentsAvailable: false,
        commercialHold: {
          active: COMMERCIAL_HOLD_ACTIVE,
          effectiveDate: COMMERCIAL_HOLD_EFFECTIVE_DATE,
        },
        plans: response.data.map(
          ({ id, name, description, maxPlants, maxMembers, limits, features }) => ({
            id,
            name,
            description,
            maxPlants,
            maxMembers,
            ...(limits ? { limits } : {}),
            ...(features ? { features } : {}),
          })
        ),
      };
    }
    return response.data;
  },

  async getCurrentSubscription(): Promise<SubscriptionState> {
    const response = await api.get<SubscriptionState>('/billing/me');
    return response.data;
  },

  /**
   * Start a Stripe Checkout session and return the URL to redirect to.
   *
   * `checkoutAttemptId` is generated once per click and forwarded as Stripe's
   * idempotency key, so a retried request (flaky network, double-click, the
   * browser replaying a request) returns the SAME session instead of opening
   * a second one. Callers must generate it at click time, not per render.
   *
   * The server re-checks both commercial gates before touching Stripe and
   * answers 503 when payment activity is off, so a stale client that still
   * shows a buy button cannot originate a charge.
   */
  async createCheckout(input: {
    planId: Exclude<PlanId, 'seedling'>;
    interval: BillingInterval;
    checkoutAttemptId: string;
  }): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/billing/checkout', input);
    // Upgrade INTENT, recorded once the session exists and we are about to
    // hand the user to Stripe. Deliberately after the await: a 503 from the
    // commercial gate, or any other failure, is not an upgrade attempt that
    // reached checkout. Its server-confirmed counterpart is
    // `subscription_activated` (backend/src/utils/serverAnalytics.ts); the
    // drop-off between the two is checkout abandonment.
    //
    // Both properties are closed enums already accepted by the server-side
    // schema (backend/src/models/telemetry.ts), so no free text is sent.
    track('subscription_upgraded', { upgradeTo: input.planId, interval: input.interval });
    return response.data;
  },

  /**
   * Start a one-time Stripe Checkout for an identification top-up pack
   * (ADR 0019). Same idempotency contract as `createCheckout`: generate the
   * attempt id at click time. The server answers 400 with
   * `details.code: TOP_UP_NOT_CONFIGURED` when the pack is not for sale in
   * its environment, 403 for non-admins, and 503 while payments are paused.
   */
  async createTopUpCheckout(input: { checkoutAttemptId: string }): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/billing/top-up/checkout', input);
    return response.data;
  },

  /**
   * Start a one-time Stripe Checkout for a gift subscription (ADR 0028):
   * `months` of `planId` for somebody else, charged to the caller's own card.
   * Same idempotency contract as `createCheckout`. The server answers 400
   * with `details.code: GIFT_NOT_CONFIGURED` when that tier cannot be given
   * in its environment, and 503 while payments are paused.
   */
  async createGiftCheckout(input: {
    planId: Exclude<PlanId, 'seedling'>;
    months: number;
    checkoutAttemptId: string;
  }): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/billing/gift/checkout', input);
    return response.data;
  },

  /**
   * Redeem a gift code onto the active household (admin only). Refusals carry
   * `details.code` (GIFT_CODE_INVALID, GIFT_CODE_EXPIRED, GIFT_CODE_REDEEMED,
   * GIFT_HOUSEHOLD_SUBSCRIBED, GIFT_ALREADY_ACTIVE, GIFT_ADDS_NOTHING,
   * GIFT_REDEEM_CONFLICT) and never consume the code.
   */
  async redeemGiftCode(input: {
    code: string;
  }): Promise<{ planId: Exclude<PlanId, 'seedling'>; endsAt: string }> {
    const response = await api.post<{ planId: Exclude<PlanId, 'seedling'>; endsAt: string }>(
      '/billing/gift/redeem',
      input
    );
    return response.data;
  },

  /** The gifts this account has bought, with their codes. */
  async listGiftPurchases(): Promise<GiftPurchase[]> {
    const response = await api.get<{ purchases: GiftPurchase[] }>('/billing/gift/purchases');
    return response.data.purchases;
  },

  /**
   * Create a Stripe billing-portal session for the household's existing
   * customer record. Only meaningful after a completed checkout — the API
   * answers 400 when no Stripe customer is on file.
   */
  async createPortalSession(): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/billing/portal', {});
    return response.data;
  },
};
