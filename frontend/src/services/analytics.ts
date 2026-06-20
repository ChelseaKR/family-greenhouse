/**
 * Frontend analytics shim. Posts product events to PostHog's `/capture/`
 * endpoint directly — no SDK, no extra bundle. Strongly typed so adding a
 * new event means adding a member to the `EventName` union; misspellings
 * fail at compile time instead of becoming a forever-orphan event in the
 * PostHog UI.
 *
 * Activation: set `VITE_POSTHOG_KEY` (project API key) and optionally
 * `VITE_POSTHOG_HOST` (defaults to https://us.i.posthog.com). With the key
 * unset, every method short-circuits to a no-op. That's the dev/local
 * default — no events leak to PostHog from local development.
 *
 * Why not posthog-js: it's ~50KB gzipped and we don't need session replay,
 * autocapture, or feature flags yet. A 30-line fetch shim covers the
 * actual use case (manual lifecycle events) without paying that cost.
 *
 * Privacy:
 *  - We send the user's Cognito sub as the `distinct_id`. We do not send
 *    email, name, plant names, or any household-identifying free text.
 *  - Event properties are limited to enum-like discriminators (e.g. plan
 *    id, member count buckets) — never user-supplied strings.
 *  - The shim respects browser Do-Not-Track when `navigator.doNotTrack`
 *    is `'1'`.
 */

const HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';
const KEY = import.meta.env.VITE_POSTHOG_KEY;

/**
 * Google Tag Manager container ID — e.g. "GTM-XXXXXX". When set, every
 * `track()` call also pushes the event to `window.dataLayer`, where GTM
 * forwards it to whichever destinations are configured (typically GA4).
 *
 * GTM-side responsibility: in tagmanager.google.com, configure a GA4
 * Configuration tag on your GA4 measurement ID, then add a GA4 Event tag
 * that fires on a "Custom Event" trigger matching the EventName union.
 * See docs/external-services-setup.md for the step-by-step.
 *
 * Privacy: same Do-Not-Track gating as the PostHog path. GTM's own
 * "Consent Mode" is not configured here — surface a cookie banner before
 * flipping this on for an audience that includes EU users.
 */
const GTM_ID: string | undefined = import.meta.env.VITE_GTM_ID;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

let gtmInitialized = false;
function ensureGtm(): void {
  if (gtmInitialized || !GTM_ID) return;
  if (typeof window === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return;
  gtmInitialized = true;
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  // Inject GTM async loader (avoids the standard inline snippet so we
  // don't have to allow 'unsafe-inline' in our CSP).
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(GTM_ID)}`;
  document.head.appendChild(s);
}

function pushToDataLayer(event: string, properties: Record<string, unknown>): void {
  if (!GTM_ID) return;
  if (typeof window === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return;
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push({ event, ...properties });
}

/**
 * The full set of events we capture. Each one represents a step in the
 * funnel or a meaningful product interaction. Adding noise here makes the
 * PostHog UI worse; only add an event when there's a question we're going
 * to answer with it.
 */
export type EventName =
  | 'signup_completed' // User confirmed their email and got their first JWT.
  | 'household_created' // First or additional household.
  | 'household_joined' // Joined an existing household via an invite link.
  | 'invite_sent' // Admin generated an invite link.
  | 'invite_accepted' // The household_joined branch where the user followed an invite.
  | 'plant_added' // Plant successfully created. Distinguishable via `plantNumber=1` for first-plant.
  | 'plants_imported' // Bulk CSV/JSON import submitted; `context` carries the row count.
  | 'task_created'
  | 'task_completed' // Includes `completionNumber` so we can chart "first task completed" funnel.
  | 'task_snoozed'
  | 'photo_uploaded'
  | 'subscription_upgraded' // Stripe checkout completed.
  | 'subscription_canceled' // User clicked through to cancel in the Stripe portal.
  | 'data_exported' // CSV download triggered.
  | 'plant_identified' // Plant.id flow completed and a suggestion was accepted.
  | 'leaf_health_checked' // Leaf-health photo submitted for a visual assessment.
  | 'plant_shared' // Cutting-share link minted for a plant card.
  | 'plant_share_accepted' // A shared cutting card was copied into a household.
  | 'cutting_graft_started' // Visitor tapped the graft CTA on a public cutting card.
  | 'household_switched' // User changed active household via the switcher.
  | 'climate_location_set'
  | 'experiment_viewed'; // A bucketed A/B variant was rendered to the visitor.

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
  /** For `subscription_upgraded` — billing cadence the user chose at checkout. */
  interval?: 'month' | 'year';
  /** Free-form context only when it's an enum or a count, never a name. */
  context?: string;
  /** For `experiment_viewed` — which experiment and assigned variant. */
  experiment?: string;
  variant?: 'A' | 'B';
}

/** Ambient distinct id — set by `identify`, cleared by `reset`. */
let distinctId: string | null = null;

/**
 * Super-properties: a small bag of enum-like values merged onto every
 * captured event, and `$set` onto the person on `identify`. Used to carry
 * an A/B experiment assignment from the anonymous landing page through to
 * the post-signup `signup_completed` event, so conversion can be sliced by
 * variant. Keep this to discriminators only — never user-supplied strings.
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

function isEnabled(): boolean {
  if (!KEY) return false;
  if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return false;
  return true;
}

async function send(event: EventName, properties: Record<string, unknown>): Promise<void> {
  const withSuper = { ...superProps, ...properties };
  // GTM dataLayer push runs whether or not PostHog is configured — they're
  // independent rails. The DNT check is inside pushToDataLayer.
  pushToDataLayer(event, withSuper);
  if (!isEnabled() || !distinctId) return;
  try {
    await fetch(`${HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: KEY,
        event,
        distinct_id: distinctId,
        properties: {
          ...withSuper,
          $lib: 'family-greenhouse-shim',
          $lib_version: '1.0.0',
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
  // Initialize GTM once we have a known user — keeps an anonymous landing-
  // page visitor from triggering the script load until they're logged in.
  ensureGtm();
  pushToDataLayer('user_identified', { userId, ...superProps, ...(traits ?? {}) });
  if (!isEnabled()) return;
  void fetch(`${HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: KEY,
      event: '$identify',
      distinct_id: userId,
      // Persist the experiment assignment (and any other super-props) on the
      // person so the eventual signup is attributable to the variant seen.
      properties: { $set: { ...superProps, ...(traits ?? {}) } },
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
  superProps = {};
}

export function track(event: EventName, props: EventProps = {}): void {
  void send(event, props as unknown as Record<string, unknown>);
}
