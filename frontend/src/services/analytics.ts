/**
 * Frontend analytics shim. Authenticated product events always go to our
 * first-party `/telemetry/product` endpoint and fan out to PostHog when a
 * project key is configured. Strongly typed so adding a new event means adding
 * a member to the `EventName` union; misspellings fail at compile time instead
 * of becoming a forever-orphan event in the PostHog UI.
 *
 * Vendor activation: set `VITE_POSTHOG_KEY` (project API key) and optionally
 * `VITE_POSTHOG_HOST` (defaults to https://us.i.posthog.com). With the key
 * unset only the PostHog rail is skipped; authenticated first-party events
 * still reach our API. In production the key is the `PRODUCTION_POSTHOG_KEY`
 * repository secret — see docs/analytics.md, "Turning PostHog on".
 *
 * Why not posthog-js: it is ~50KB gzipped and we do not need session replay,
 * autocapture, feature flags or surveys. A fetch shim covers the actual use
 * case (manual lifecycle events) without paying that cost — and, more to the
 * point, it is COOKIELESS BY CONSTRUCTION. Nothing in this module reads or
 * writes a cookie, localStorage or sessionStorage. The only identity is the
 * Cognito `sub` handed in by `identify()` after sign-in and held in module
 * memory (what posthog-js would call `persistence: 'memory'`). There is no
 * anonymous id, no device id, no cross-site identifier and nothing that
 * survives a page load, which is why this rail needs no consent banner.
 *
 * Privacy (docs/analytics.md is the full statement; keep the two in step):
 *  - `distinct_id` is the Cognito sub, set only after sign-in. We never send
 *    email, name, plant names, or any household-identifying free text.
 *  - `$groups.household` is the opaque household UUID — see
 *    `setActiveHousehold`. A UUID grouping key cannot be reversed to a
 *    person, home or address; it is what makes the collaboration funnel
 *    (does a household get a 2nd active member?) measurable across users.
 *  - Event properties are enum-like discriminators (plan id, count buckets,
 *    a route family) — never user-supplied strings. The API accept-list in
 *    backend/src/models/telemetry.ts has the same shape.
 *  - No page views, no autocapture, no form contents, no session recording.
 *  - `$geoip_disable: true` rides on every PostHog payload so PostHog does not
 *    derive a city or region from the request's IP address.
 *  - Opt-out: the in-app switch (Settings → Preferences), Global Privacy
 *    Control (`navigator.globalPrivacyControl`) or Do Not Track
 *    (`navigator.doNotTrack === '1'`) each silence EVERY rail in this module —
 *    PostHog and the first-party endpoint alike; see `analyticsOptedOut`.
 *    Under any of them nothing is sent, nothing is queued and nothing is
 *    stored. GPC is a legally binding opt-out for California residents
 *    (CCPA/CPRA), and the post-deploy smoke test declares it, which is how
 *    test fixtures stay out of the dashboards. The switch exists because the
 *    iOS shell can send neither signal.
 */

const HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';
const KEY = import.meta.env.VITE_POSTHOG_KEY;
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

/**
 * The full set of events we capture. Each one represents a step in the
 * funnel or a meaningful product interaction. Adding noise here makes the
 * PostHog UI worse; only add an event when there's a question we're going
 * to answer with it.
 */
export type EventName =
  | 'signup_started' // Registration form accepted by the API (account exists, unconfirmed). Held and replayed at first sign-in.
  | 'signup_completed' // User confirmed their email; the backend records the trusted first-party event.
  | 'household_created' // First or additional household.
  | 'household_joined' // Joined an existing household via an invite link.
  | 'invite_sent' // Admin generated an invite link.
  | 'invite_accepted' // The household_joined branch where the user followed an invite.
  | 'plant_added' // Plant successfully created. Distinguishable via `plantNumber=1` for first-plant.
  | 'plant_lifecycle_changed' // Archived, restored, died, or gave away; `context` is the new status.
  | 'plants_imported' // Bulk CSV/JSON import submitted; `context` carries the row count.
  | 'plants_moved' // Quick or bulk placement change; `context` carries the plant count.
  | 'task_created'
  | 'task_completed' // Includes `completionNumber` so we can chart "first task completed" funnel.
  | 'task_snoozed'
  | 'photo_uploaded'
  | 'plan_limit_hit' // The API refused a request with 402: a plan cap reached or a locked feature met. `context` is the route family.
  | 'billing_opened' // Settings → Billing rendered. The one page-level event; it is the step before checkout.
  | 'subscription_upgraded' // Stripe checkout session created — checkout STARTED, not paid.
  | 'subscription_canceled' // User clicked through to cancel in the Stripe portal.
  | 'data_exported' // CSV download triggered.
  | 'plant_identified' // Plant.id flow completed and a suggestion was accepted.
  | 'leaf_health_checked' // Leaf-health photo submitted for a visual assessment.
  | 'plant_shared' // Cutting-share link minted for a plant card.
  | 'plant_share_accepted' // A shared cutting card was copied into a household.
  | 'cutting_graft_started' // Visitor tapped the graft CTA on a public cutting card.
  | 'household_switched' // User changed active household via the switcher.
  | 'shared_care_pulse_action' // Dashboard setup action or 30-day dismissal; `context` names the step.
  | 'climate_location_set'
  | 'experiment_viewed' // A bucketed A/B variant was rendered to the visitor.
  | 'upgrade_requested'; // A member asked the admins to upgrade for a locked feature; `upgradeTo` names the tier.

export interface EventProps {
  /** Plan identifier when the event is plan-relevant. */
  plan?: 'seedling' | 'garden' | 'greenhouse';
  /** Discriminate first-of-its-kind events from repeat ones. */
  ordinal?: 'first' | 'subsequent';
  /** For `task_created` / `task_completed` — what kind of task. */
  taskType?: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';
  /** For `household_created` — bucketed member count of the new household. */
  memberCount?: '1' | '2-5' | '6+';
  /** For `subscription_upgraded` — bucketed price. */
  upgradeTo?: 'garden' | 'greenhouse';
  /** For `subscription_upgraded` — billing cadence the user chose at checkout.
   *  `lifetime` is a one-time payment rather than a recurring cadence. */
  interval?: 'month' | 'year' | 'lifetime';
  /** Free-form context only when it's an enum or a count, never a name. */
  context?: string;
  /** For `experiment_viewed` — which experiment and assigned variant. */
  experiment?: string;
  variant?: 'A' | 'B';
}

/**
 * The browser's opt-out signals. Either one silences every rail in this
 * module.
 *
 * Global Privacy Control is the signal the CCPA/CPRA regulations name as a
 * valid request to opt out of sale or sharing, so it is honoured as exactly
 * that: no product event leaves the device for PostHog or for our own API.
 * Do Not Track has no legal weight but the privacy page has promised to honour
 * it since the first release, and it also gates the first-party operational
 * rail (`frontendTelemetry.ts`), which GPC deliberately does not: error
 * summaries and Web Vitals identify no one, so they are not a "share".
 *
 * Read at call time, never cached, so a signal that appears mid-session (a
 * browser setting flipped in another tab) takes effect on the next event.
 */
export function analyticsOptedOut(): boolean {
  if (analyticsOptOutStored()) return true;
  if (typeof navigator === 'undefined') return false;
  if (navigator.doNotTrack === '1') return true;
  // Not in lib.dom yet; Firefox, Brave and DuckDuckGo expose it as a boolean.
  // `'1'` is accepted too: erring towards opt-out is the safe direction.
  const gpc = (navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl;
  return gpc === true || gpc === '1';
}

/**
 * The in-app opt-out: Settings → Preferences → Product analytics.
 *
 * A per-device flag, because the two browser signals do not exist everywhere.
 * WKWebView never sends `DNT: 1` and WebKit has no Global Privacy Control, so
 * inside the iOS shell this switch is the ONLY way to opt out; in a browser it
 * is the way for someone who has not configured either signal. It is the one
 * thing this module ever writes to the device, and only when the person asks
 * for it — a preference, not an identifier — so the cookieless claim above
 * still holds: nothing here can be used to recognise anyone.
 */
export const ANALYTICS_OPT_OUT_STORAGE_KEY = 'fg-analytics-opt-out';

export function analyticsOptOutStored(): boolean {
  try {
    return localStorage.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY) === '1';
  } catch {
    // Storage unavailable (private mode, quota, no window): only the browser
    // signals remain, and they are checked separately.
    return false;
  }
}

export function setAnalyticsOptOut(optOut: boolean): void {
  try {
    if (optOut) localStorage.setItem(ANALYTICS_OPT_OUT_STORAGE_KEY, '1');
    else localStorage.removeItem(ANALYTICS_OPT_OUT_STORAGE_KEY);
  } catch {
    // Nothing to do: the preference could not be kept, and the next render of
    // the switch reads the stored value back, so the UI cannot claim otherwise.
  }
  // Opting out also drops anything held for replay: an event queued before the
  // person said no is still an event they said no to.
  if (optOut) pendingPreIdentity = [];
}

/** Ambient distinct id — set by `identify`, cleared by `reset`. */
let distinctId: string | null = null;
let telemetryToken: string | null = null;

/** Keep the first-party rail authenticated without importing the axios
 * singleton (which would create an analytics → authStore → analytics cycle). */
export function setTelemetryAuthToken(token: string | null): void {
  telemetryToken = token;
  // `authStore` sets the token and calls `identify()` together, in either
  // order depending on the path (login vs. session restore); whichever
  // completes the pair releases anything queued while anonymous.
  flushPendingPreIdentity();
}

/**
 * Super-properties: a small bag of enum-like values merged onto every
 * captured event, and `$set` onto the person on `identify`. Used to carry
 * an A/B experiment assignment from the anonymous landing page through to
 * authenticated post-signup events, so conversion after login can be sliced
 * by variant. Keep this to discriminators only — never user-supplied strings.
 *
 * Removal: drop `registerSuperProperties` + the `...superProps` merges
 * below and this whole block goes away cleanly.
 */
let superProps: Record<string, string> = {};

/**
 * Register persistent super-properties merged onto all subsequent events.
 * Shallow-merges, so callers can register one experiment without clobbering
 * another. Values must be enum-like discriminators.
 */
export function registerSuperProperties(props: Record<string, string>): void {
  superProps = { ...superProps, ...props };
}

/**
 * Active household — the PostHog group key (`$groups.household`) attached to
 * every event. Set by `setActiveHousehold`, cleared by `reset` (logout). An
 * opaque UUID, never free text (see the Privacy block above). This is the
 * shared key that lets PostHog pair events across DIFFERENT users in the same
 * household — `invite_sent` (admin) → `invite_accepted` (invitee), or "count
 * distinct active members" — which the per-user `distinct_id` alone cannot do.
 */
let activeHouseholdId: string | null = null;

/** Households we've already `$groupidentify`-ed this session, so we only emit
 *  the group-identify event once per household rather than on every switch. */
const groupIdentified = new Set<string>();

/**
 * Events fired before any identity existed, held until one does.
 *
 * Every rail here is identity-gated — PostHog needs a `distinct_id` and the
 * first-party `/telemetry/product` endpoint needs a JWT — so an event fired by
 * a signed-out visitor would otherwise evaporate. Four events do exactly that:
 * `signup_started` (the register form), `signup_completed` (the confirmation
 * code), `experiment_viewed` (the landing hero A/B test) and
 * `cutting_graft_started` (the graft CTA on a public cutting card).
 *
 * The fix is deferral, not anonymous beaconing. Nothing is sent while the
 * visitor is anonymous — the privacy posture is unchanged, and the
 * characterization tests in analytics.test.ts still assert zero network
 * traffic before `identify()`. The event is replayed once the SAME browser tab
 * signs in, which is the only point at which we have an identity to attach it
 * to. Register → confirm → sign in is one tab by design, so the two sign-up
 * steps normally survive; a visitor who confirms from a reminder email in a
 * fresh tab loses `signup_started` (the server's own log still has it).
 *
 * What this buys and what it does not: the numerator becomes measurable
 * ("of the people who signed up, how many saw variant B?"), the denominator
 * does not ("how many people saw variant B?"). Impressions by visitors who
 * never sign in remain unmeasurable, and making them measurable is the
 * top-of-funnel privacy decision in docs/analytics.md, not this module.
 */
interface PendingEvent {
  event: EventName;
  properties: Record<string, unknown>;
}
let pendingPreIdentity: PendingEvent[] = [];

/**
 * Small on purpose. A visitor can bounce around anonymous pages indefinitely;
 * this holds a handful of distinct funnel steps, not a session recording. When
 * full we keep the OLDEST entries — the landing impression that started the
 * journey is the one worth attributing, not the tenth re-render.
 */
const MAX_PENDING_PRE_IDENTITY = 5;

/**
 * Replay anything queued while anonymous, once BOTH identity halves exist.
 *
 * Both are required. `distinctId` alone opens only the PostHog rail, and
 * flushing then would consume the queue before the first-party rail could see
 * it. `authStore` sets the token and calls `identify()` together on login and
 * on session restore, so whichever lands second triggers the flush.
 */
function flushPendingPreIdentity(): void {
  if (!distinctId || !telemetryToken) return;
  if (pendingPreIdentity.length === 0) return;
  const queued = pendingPreIdentity;
  pendingPreIdentity = [];
  for (const item of queued) {
    void send(item.event, item.properties);
  }
}

/**
 * `plan_limit_hit` bookkeeping. The axios response interceptor calls
 * `planLimitHitContext` for every 402 so the funnel's "hit a limit" step is
 * counted once for every gated surface — plant cap, member cap, homes cap,
 * API keys, chat, cross-home Today, the identify allowance — without each call
 * site remembering to instrument it.
 *
 * The context is the route FAMILY, never the route: ids and tokens are
 * dropped, at most two static segments survive, and the result is forced into
 * the server's `context` alphabet (`^[a-z][a-z0-9_-]{0,31}$`) so nothing a
 * user typed can ride along. `/households/<uuid>/members` → `households_members`.
 *
 * Deduped per context for a short window because a react-query read that
 * answers 402 may be retried, and three retries of one refusal are one limit
 * hit, not three.
 */
const PLAN_LIMIT_DEDUPE_MS = 10_000;
const recentPlanLimitHits = new Map<string, number>();
const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function looksLikeIdentifier(segment: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment) ||
    /^\d+$/u.test(segment) ||
    /^[A-Za-z0-9_-]{24,}$/u.test(segment)
  );
}

/** The bounded route family of a request URL — exported for its tests. */
export function planLimitContext(url: string | undefined): string {
  let pathname: string;
  try {
    pathname = new URL(url ?? '', 'http://request.invalid').pathname;
  } catch {
    return 'other';
  }
  const context = pathname
    .split('/')
    .filter((segment) => segment.length > 0 && !looksLikeIdentifier(segment))
    .slice(0, 2)
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9_-]/gu, ''))
    .filter((segment) => segment.length > 0)
    .join('_')
    .slice(0, 32);
  return CONTEXT_PATTERN.test(context) ? context : 'other';
}

/**
 * The `context` to record for a 402 answered at `url`, or `null` when the same
 * route family was already counted within the dedupe window.
 */
export function planLimitHitContext(url: string | undefined, now = Date.now()): string | null {
  const context = planLimitContext(url);
  const last = recentPlanLimitHits.get(context);
  if (last !== undefined && now - last < PLAN_LIMIT_DEDUPE_MS) return null;
  recentPlanLimitHits.set(context, now);
  return context;
}

/**
 * Pin subsequent events to a household group. Call on login/session restore
 * and whenever the active household changes (the household switcher). Pass
 * `null` to detach (e.g. a user with no household yet). The id is the opaque
 * household UUID — never a name or address.
 *
 * On the first time we see a given household this session we emit a PostHog
 * `$groupidentify` so the group exists in the UI; subsequent calls just swap
 * the ambient key.
 */
export function setActiveHousehold(householdId: string | null): void {
  activeHouseholdId = householdId;
  if (!householdId) return;
  if (!isEnabled() || groupIdentified.has(householdId)) return;
  groupIdentified.add(householdId);
  void fetch(`${HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: KEY,
      event: '$groupidentify',
      // `$groupidentify` is keyed by the group itself; PostHog ignores the
      // distinct_id here but the field is required, so reuse the household id.
      distinct_id: householdId,
      properties: {
        $group_type: 'household',
        $group_key: householdId,
        $group_set: {},
        $geoip_disable: true,
      },
      timestamp: new Date().toISOString(),
    }),
    keepalive: true,
  }).catch(() => {});
}

function isEnabled(): boolean {
  if (!KEY) return false;
  return !analyticsOptedOut();
}

async function send(event: EventName, properties: Record<string, unknown>): Promise<void> {
  // Opted out: nothing is sent, nothing is queued. Checked before the queue on
  // purpose — holding an event for later would be storing what the visitor
  // asked us not to collect.
  if (analyticsOptedOut()) return;
  const withSuper = { ...superProps, ...properties };

  // No identity yet: both rails are identity-gated, so this event would
  // vanish. Hold it for replay after sign-in instead of dropping it — and
  // send NOTHING now (see pendingPreIdentity: no anonymous beaconing).
  if (!distinctId) {
    if (pendingPreIdentity.length < MAX_PENDING_PRE_IDENTITY) {
      pendingPreIdentity.push({ event, properties });
    }
    return;
  }

  // First-party product analytics is the default rail. Identity and household
  // come from the verified JWT server-side; neither is accepted in this body.
  if (distinctId && telemetryToken) {
    void fetch(`${API_URL}/telemetry/product`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${telemetryToken}`,
        ...(activeHouseholdId ? { 'X-Household-Id': activeHouseholdId } : {}),
      },
      body: JSON.stringify({
        event,
        properties,
        superProperties: superProps,
      }),
      keepalive: true,
    }).catch(() => {});
  }
  if (!isEnabled() || !distinctId) return;
  try {
    await fetch(`${HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: KEY,
        event,
        distinct_id: distinctId,
        // Attach the household group so this event is countable per-household
        // across users (collaboration funnel). Omitted entirely when no
        // household is active so we never send a stray `{ household: null }`.
        ...(activeHouseholdId ? { $groups: { household: activeHouseholdId } } : {}),
        properties: {
          ...withSuper,
          $geoip_disable: true,
          $lib: 'family-greenhouse-shim',
          $lib_version: '1.1.0',
        },
        timestamp: new Date().toISOString(),
      }),
      keepalive: true, // survive page-unload during navigation events
    });
  } catch {
    // Never throw to the caller — analytics failures must not break UX.
  }
}

/**
 * Pin subsequent events to a user. Call on login + on session restore.
 * Pass the Cognito sub as `userId` and a small set of stable traits.
 */
export function identify(userId: string, traits?: { plan?: EventProps['plan'] }): void {
  distinctId = userId;
  // Release anything the visitor generated before identity existed. This runs
  // BEFORE the PostHog gate below so the replay happens on the first-party
  // rail whether or not PostHog is configured.
  flushPendingPreIdentity();
  if (!isEnabled()) return;
  void fetch(`${HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: KEY,
      event: '$identify',
      distinct_id: userId,
      // Tie the person to their household group as well, so the $identify
      // itself is attributable per-household.
      ...(activeHouseholdId ? { $groups: { household: activeHouseholdId } } : {}),
      // Persist the experiment assignment (and any other super-props) on the
      // person so the eventual signup is attributable to the variant seen.
      properties: { $set: { ...superProps, ...(traits ?? {}) }, $geoip_disable: true },
      timestamp: new Date().toISOString(),
    }),
    keepalive: true,
  }).catch(() => {});
}

/** Drop the distinct id (and super-properties) on logout so subsequent
 *  events don't leak across users. The landing page re-registers the
 *  experiment assignment from localStorage on the next visit. */
export function reset(): void {
  distinctId = null;
  telemetryToken = null;
  superProps = {};
  activeHouseholdId = null;
  // Anything still queued was generated by the departing session. Replaying it
  // against the NEXT user would attribute one person's landing impression to
  // another, so logout drops it.
  pendingPreIdentity = [];
  // Allow a re-login to re-`$groupidentify`; cheap and keeps logout total.
  groupIdentified.clear();
  recentPlanLimitHits.clear();
}

export function track(event: EventName, props: EventProps = {}): void {
  void send(event, props as unknown as Record<string, unknown>);
}
