/**
 * Google Analytics 4, started from the document instead of from the app.
 *
 * Built as its own entry (vite.googleAnalyticsBoot.ts) and placed in the
 * <head> of every page the production web build emits, ahead of the app
 * bundle. It does what services/googleAnalytics.ts did at boot — checks every
 * condition that keeps GA off, tells gtag.js its consent defaults and
 * configuration, appends the gtag.js script — and, on a prerendered public
 * page, sends that page's view. The app's loader then adopts what happened
 * here (`window.__fgGoogleAnalyticsBoot`) instead of doing it again, and
 * `trackGooglePageView` counts that first page once.
 *
 * Why (measured 2026-11-07, Pixel 7 profile, slow 4G, 4x CPU): the page view
 * left about 4.0 s into a care-page load, because gtag.js was not even
 * requested until the app bundle had downloaded and run. A visitor who read
 * the watering answer (on screen at 1.6 s) and left before that was never
 * counted. Nothing new is sent and nothing is sent that consent did not
 * already allow: the conditions, the consent defaults and the configuration
 * are the loader's own, held to it command for command by
 * googleAnalyticsBoot.test.ts.
 *
 * This module imports nothing at runtime, so it is one small request on the
 * connection the HTML came over rather than a chunk graph. The constants it
 * shares with services/googleAnalytics.ts, services/analytics.ts and
 * store/authStore.ts are therefore repeated here, each one pinned by a test.
 *
 * Only a prerendered page gets its page view from here, because only there is
 * the address known to be one of our own published paths: scripts/
 * prerender.mjs stamps `data-prerendered` on #root with the route it rendered,
 * and the view is sent only when that stamp equals `location.pathname`
 * exactly — the test main.tsx applies before hydrating. The app shell (the
 * dashboard, a plant page, any URL carrying a token) has no stamp, so its page
 * view keeps coming from the app, scrubbed by `gaPagePath`. The title is the
 * document's build-time title; the query keeps `utm_*` only; the referrer is
 * reduced to its origin, our own included, so a full page load from one of
 * our tokenized pages reveals nothing.
 *
 * The home page is skipped for a signed-in visitor: App sends them to
 * /dashboard before React paints, and the app's loader counts that route, as
 * it always has.
 */
import type { GoogleAnalyticsBootState } from './services/googleAnalytics';

/** `gaMeasurementId` in services/googleAnalytics.ts. */
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;
const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';
/** `ANALYTICS_OPT_OUT_STORAGE_KEY` in services/analytics.ts. */
const OPT_OUT_STORAGE_KEY = 'fg-analytics-opt-out';
/** The persist `name` of store/authStore.ts. */
const AUTH_STORAGE_KEY = 'auth-storage';
/** `KEPT_QUERY_PARAMS` in services/googleAnalytics.ts. */
const KEPT_QUERY_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
];
/** `GENERIC_PAGE_TITLE` in services/googleAnalytics.ts. */
const GENERIC_PAGE_TITLE = 'Family Greenhouse';
/** `CONSENT_DENIED_REGIONS` in services/googleAnalytics.ts, same order. */
// prettier-ignore
const CONSENT_DENIED_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'AX', 'GF', 'GP', 'MQ', 'MF', 'RE', 'YT',
  'IS', 'LI', 'NO', 'GB', 'CH',
];
/** A prerendered route: `/`, or lowercase words and hyphens joined by slashes. */
const PUBLIC_PATH_PATTERN = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/u;
/** `CONTENT_ROUTE_PREFIXES` and `TOKEN_ROUTE_PREFIXES` in services/googleAnalytics.ts. */
const CONTENT_ROUTE_PREFIXES = ['blog', 'care', 'pet-safe', 'help'];
const TOKEN_ROUTE_PREFIXES = ['join', 'shared', 'sit', 'kiosk', 'tag', 'caretaker'];

/** `analyticsOptedOut` in services/analytics.ts: the switch, then the signals. */
function optedOut(): boolean {
  try {
    if (localStorage.getItem(OPT_OUT_STORAGE_KEY) === '1') return true;
  } catch {
    // Storage unavailable: only the browser signals remain.
  }
  if (navigator.doNotTrack === '1') return true;
  const gpc = (navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl;
  return gpc === true || gpc === '1';
}

/** `isNativeApp` in lib/platform.ts. */
function isNativeApp(): boolean {
  const capacitor = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

/** Whether the persisted auth store says this browser is signed in. */
function signedIn(): boolean {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: { isAuthenticated?: unknown } } | null)?.state;
    return state?.isAuthenticated === true;
  } catch {
    return false;
  }
}

/** `gaQuery` in services/googleAnalytics.ts. */
function campaignQuery(search: string): string {
  const input = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of KEPT_QUERY_PARAMS) {
    const value = input.get(key);
    if (value) kept.set(key, value.slice(0, 100));
  }
  const query = kept.toString();
  return query ? `?${query}` : '';
}

/**
 * Whether the loader's `gaPagePath` would send this path verbatim: one of our
 * content slugs, or a path with no bearer-credential family and no segment its
 * scrubbing would replace (a 24-character-or-longer token, a UUID, a bare
 * number). The stamp only ever carries a published route, so this is a second
 * lock, not the first; googleAnalyticsBoot.test.ts runs every published route
 * through both sides.
 */
function isPublishedPath(path: string): boolean {
  if (!PUBLIC_PATH_PATTERN.test(path)) return false;
  const segments = path.split('/');
  const family = segments[1] ?? '';
  if (CONTENT_ROUTE_PREFIXES.includes(family) && segments.length === 3) return true;
  if (TOKEN_ROUTE_PREFIXES.includes(family)) return false;
  return !segments.some((segment) => segment.length >= 24 || /^\d+$/u.test(segment));
}

/** The referrer's origin only, whichever site it is. '' when there is none. */
function referrerOrigin(referrer: string): string {
  if (!referrer) return '';
  try {
    return `${new URL(referrer).origin}/`;
  } catch {
    return '';
  }
}

function bootGoogleAnalytics(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__fgGoogleAnalyticsBoot) return;
  const raw: unknown = import.meta.env.VITE_GA_MEASUREMENT_ID;
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!MEASUREMENT_ID_PATTERN.test(id)) return;
  if (isNativeApp() || optedOut()) return;

  // Google's kill switch, read before every hit; see the loader for why a getter.
  Object.defineProperty(window, `ga-disable-${id}`, { configurable: true, get: optedOut });

  const dataLayer = (window.dataLayer = window.dataLayer ?? []);
  // gtag.js only treats an `arguments` object as a command.
  const push = function gtagPush() {
    // eslint-disable-next-line prefer-rest-params -- gtag.js requires the arguments object itself
    dataLayer.push(arguments);
  } as (...args: unknown[]) => void;

  push('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    region: CONSENT_DENIED_REGIONS,
  });
  push('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  });
  push('set', 'ads_data_redaction', true);
  push('js', new Date());
  push('config', id, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `${GTAG_SRC}?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);

  let pageLocation: string | null = null;
  const prerendered = document.getElementById('root')?.dataset.prerendered;
  if (
    prerendered !== undefined &&
    prerendered === window.location.pathname &&
    isPublishedPath(prerendered) &&
    !(prerendered === '/' && signedIn())
  ) {
    pageLocation = `${window.location.origin}${prerendered}${campaignQuery(window.location.search)}`;
    const params: Record<string, string> = {
      page_location: pageLocation,
      page_title: (document.title || GENERIC_PAGE_TITLE).slice(0, 300),
    };
    const referrer = referrerOrigin(document.referrer);
    if (referrer) params.page_referrer = referrer;
    push('set', params);
    push('event', 'page_view');
  }

  const state: GoogleAnalyticsBootState = { id, pageLocation };
  window.__fgGoogleAnalyticsBoot = state;
}

bootGoogleAnalytics();
