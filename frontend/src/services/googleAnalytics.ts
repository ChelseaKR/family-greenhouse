/**
 * Google Analytics 4 — the website's visit counter. Web only, never native.
 *
 * Decision, 2026-09-17: GA4 on every public site, alongside PostHog (which is
 * untouched — see analytics.ts). docs/analytics.md, "Google Analytics 4", is
 * the design; the privacy page (`legal.privacy.collect.googleAnalytics`,
 * `legal.privacy.thirdParties.googleAnalytics`) is the disclosure. Keep the
 * three in step.
 *
 * Nothing loads unless ALL of these hold, checked once at boot:
 *
 *  - a measurement ID was built in (`VITE_GA_MEASUREMENT_ID`, a `G-…` value).
 *    Only the production web build sets it (.github/workflows/cd-production.yml);
 *    local dev, CI, staging and the native store builds leave it unset, and an
 *    unset or malformed value loads nothing;
 *  - this is not the Capacitor iOS/Android shell (`isNativeApp()`). The iOS
 *    app's App Privacy answers do not cover GA, and scripts/validate-store-
 *    release.mjs refuses a native build that sets the ID at all;
 *  - no opt-out applies: the in-app switch, Global Privacy Control or Do Not
 *    Track — the same `analyticsOptedOut()` that silences PostHog. The
 *    post-deploy smoke declares GPC before boot, which is how test fixtures
 *    stay out of GA exactly as they stay out of PostHog.
 *
 * What it sends, and what it is told:
 *
 *  - Consent Mode v2 defaults: `ad_storage`, `ad_user_data` and
 *    `ad_personalization` denied everywhere; `analytics_storage` denied in the
 *    EEA, the UK and Switzerland (no `_ga` cookies there — GA still sends
 *    cookieless pings) and granted elsewhere. Nothing ever updates them.
 *  - `allow_google_signals: false`, `allow_ad_personalization_signals: false`,
 *    and `ads_data_redaction` on.
 *  - Page views are sent HERE, explicitly, on every SPA route change
 *    (`trackGooglePageView`, driven by components/GoogleAnalyticsPageViews),
 *    with `send_page_view: false` so the config call does not send its own.
 *    The page address is scrubbed first (`gaPagePath`, `gaPageLocation`):
 *    sharing-link and invite tokens and record ids become placeholders and
 *    only `utm_*` survives from the query string. A page whose address carried
 *    an id also gets a generic title, because PlantDetailPage titles itself
 *    with the plant's user-typed name. `set` carries the scrubbed address and
 *    title onto every later hit as well, so GA's own automatic events inherit
 *    them instead of reading `location.href` and `document.title`.
 *
 *    Measured against the live gtag.js (docs/analytics.md): enhanced
 *    measurement's "page changes based on browser history events", where a
 *    container serves it, fires on `pushState` REGARDLESS of `send_page_view`
 *    and reads the raw URL — a duplicate page view carrying the token this
 *    module removes. The container served for this property today carries no
 *    history listener, but that is Google's to change, so the stream setting
 *    must be off; docs/analytics.md lists it as an owner step.
 *  - No user id, no account id, no household id, no event other than
 *    `page_view`. GA is a visit counter here, not a second product-analytics
 *    rail — the funnel stays in analytics.ts.
 *
 * Opting out mid-visit: `window['ga-disable-<id>']` — Google's documented kill
 * switch — is defined as a getter over `analyticsOptedOut()`, so the next hit
 * after the switch is flipped (or a signal appears) is not sent. Measured: no
 * request leaves after the flip. `clearGoogleAnalyticsCookies()` then removes
 * the `_ga`/`_ga_*` cookies already set; it also runs at boot whenever an
 * opt-out is in force, so a visitor who opts out later is not left carrying
 * the old identifier.
 */
import { isNativeApp } from '@/lib/platform';
import { analyticsOptedOut } from '@/services/analytics';
import { normalizeTelemetryRoute } from '@/services/frontendTelemetry';

const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;
const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';

/**
 * Where Consent Mode denies `analytics_storage` by default: the EEA (the 27 EU
 * member states plus Iceland, Liechtenstein and Norway), the United Kingdom
 * and Switzerland, as ISO 3166-1 alpha-2 codes. The EU's outermost regions and
 * Åland that carry their own ISO codes are listed too, so a visitor there is
 * not treated as outside the EU; erring towards "denied" is the safe
 * direction. gtag.js resolves the visitor's region from the request that
 * served it — no extra lookup.
 */
// prettier-ignore
export const CONSENT_DENIED_REGIONS: readonly string[] = [
  // EU member states
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EU territories with their own ISO codes
  'AX', 'GF', 'GP', 'MQ', 'MF', 'RE', 'YT',
  // Rest of the EEA, the UK and Switzerland
  'IS', 'LI', 'NO', 'GB', 'CH',
];

/**
 * Route families whose second segment is a bearer credential: an invite code,
 * a shared-cutting code, a sitter, kiosk, plant-tag or caretaker token. Some
 * of these are short enough to survive `normalizeTelemetryRoute`'s length
 * heuristic, so they are replaced by position, not by shape.
 */
const TOKEN_ROUTE_PREFIXES = new Set(['join', 'shared', 'sit', 'kiosk', 'tag', 'caretaker']);

/**
 * Route families whose second segment is one of our own published slugs — a
 * blog post, care guide, pet-safety page or help topic. Kept verbatim, because
 * they are the pages GA exists to count and several blog slugs are long enough
 * that `normalizeTelemetryRoute` would mistake them for tokens. Only the slug
 * shape (lowercase words joined by hyphens) is kept; anything else under these
 * prefixes is scrubbed like any other path.
 */
const CONTENT_ROUTE_PREFIXES = new Set(['blog', 'care', 'pet-safe', 'help']);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Campaign tags are the only query parameters worth GA's acquisition reports. */
const KEPT_QUERY_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
] as const;

/** Stands in for any title that could carry something a household typed. */
export const GENERIC_PAGE_TITLE = 'Family Greenhouse';

type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

let gtag: Gtag | null = null;
/** The last page view sent: the dedupe key, and the next view's referrer. */
let lastPageLocation: string | null = null;
/** The scrubbed `document.referrer`, used as the first view's referrer. */
let entryReferrer = '';

/** The built-in measurement ID, or null when unset or not a GA4 `G-…` ID. */
export function gaMeasurementId(
  raw: unknown = import.meta.env.VITE_GA_MEASUREMENT_ID
): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return MEASUREMENT_ID_PATTERN.test(id) ? id : null;
}

/** A pathname with credentials and record ids replaced by placeholders. */
export function gaPagePath(pathname: string): string {
  const path = pathname.split(/[?#]/u, 1)[0] || '/';
  const segments = path.split('/');
  const family = segments[1] ?? '';
  if (
    CONTENT_ROUTE_PREFIXES.has(family) &&
    segments.length === 3 &&
    SLUG_PATTERN.test(segments[2] ?? '')
  ) {
    return path.slice(0, 180);
  }
  // ['', 'sit', '<token>', 'brief'] — the credential is always segment 2.
  if (TOKEN_ROUTE_PREFIXES.has(family) && segments.length > 2 && segments[2]) {
    segments[2] = ':token';
  }
  return normalizeTelemetryRoute(segments.join('/') || '/');
}

/** Only the campaign tags, in a fixed order, or '' when there are none. */
export function gaQuery(search: string): string {
  const input = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of KEPT_QUERY_PARAMS) {
    const value = input.get(key);
    if (value) kept.set(key, value.slice(0, 100));
  }
  const query = kept.toString();
  return query ? `?${query}` : '';
}

/** The page address GA receives: scrubbed path, campaign tags, no fragment. */
export function gaPageLocation(origin: string, pathname: string, search: string): string {
  return `${origin}${gaPagePath(pathname)}${gaQuery(search)}`;
}

/**
 * The referrer GA receives. Another site is reduced to its origin, which is
 * all acquisition reporting needs; one of our own pages (a full page load from
 * a sitter link, say) is scrubbed like any other page address.
 */
export function gaReferrer(referrer: string, origin: string): string {
  if (!referrer) return '';
  try {
    const url = new URL(referrer);
    if (url.origin === origin) return gaPageLocation(origin, url.pathname, url.search);
    return `${url.origin}/`;
  } catch {
    return '';
  }
}

/**
 * Remove the GA cookies (`_ga`, `_ga_<container>`). GA writes them on the
 * widest domain that accepts cookies (`.familygreenhouse.net` from
 * `www.familygreenhouse.net`), and a cookie can only be removed with the
 * domain it was set on, so every suffix of the current host is tried.
 */
export function clearGoogleAnalyticsCookies(): void {
  if (typeof document === 'undefined' || typeof location === 'undefined') return;
  const names = document.cookie
    .split(';')
    .map((pair) => pair.split('=', 1)[0].trim())
    .filter((name) => /^_ga(?:_[A-Za-z0-9]+)?$/u.test(name));
  if (names.length === 0) return;
  const labels = location.hostname.split('.');
  const domains = [''];
  for (let i = 0; i < labels.length - 1; i += 1) domains.push(labels.slice(i).join('.'));
  for (const name of names) {
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ''}`;
    }
  }
}

/**
 * Load GA if — and only if — every condition in the header holds. Returns
 * whether it loaded. Idempotent: a second call does nothing.
 */
export function initGoogleAnalytics(): boolean {
  if (gtag) return true;
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const id = gaMeasurementId();
  if (!id) return false;
  if (isNativeApp()) return false;
  if (analyticsOptedOut()) {
    clearGoogleAnalyticsCookies();
    return false;
  }

  // Google's documented kill switch, read by gtag.js before every hit. A getter
  // rather than a value so an opt-out that arrives mid-visit is honoured on
  // the very next hit, exactly as analytics.ts re-reads it on every event.
  Object.defineProperty(window, `ga-disable-${id}`, {
    configurable: true,
    get: () => analyticsOptedOut(),
  });

  const dataLayer = (window.dataLayer = window.dataLayer ?? []);
  // gtag.js only treats an `arguments` object as a command; an array pushed in
  // its place is silently ignored, so this cannot be a rest-parameter arrow.
  const push: Gtag = function gtagPush() {
    // eslint-disable-next-line prefer-rest-params -- gtag.js requires the arguments object itself (see above)
    dataLayer.push(arguments);
  };

  // The more specific default wins where both match, so the order is only for
  // the reader: denied in the listed regions, analytics granted elsewhere.
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

  gtag = push;
  entryReferrer = gaReferrer(document.referrer, window.location.origin);
  return true;
}

/**
 * Record one page view for the current route. A no-op unless GA loaded, and
 * silent under an opt-out that appeared after it did. Consecutive calls for
 * the same scrubbed address count once (React StrictMode re-runs effects; a
 * `replace` navigation to the same page is not a new view).
 */
export function trackGooglePageView(
  pathname: string,
  search: string,
  title: string = typeof document === 'undefined' ? '' : document.title
): void {
  if (!gtag || analyticsOptedOut()) return;
  const origin = window.location.origin;
  const pageLocation = gaPageLocation(origin, pathname, search);
  if (pageLocation === lastPageLocation) return;
  // A path that needed scrubbing belongs to a record or a credential, and its
  // title may be user-typed (a plant's name), so it gets the generic one.
  const scrubbed = gaPagePath(pathname) !== (pathname.split(/[?#]/u, 1)[0] || '/');
  const pageTitle = (scrubbed || !title ? GENERIC_PAGE_TITLE : title).slice(0, 300);
  const params: Record<string, string> = { page_location: pageLocation, page_title: pageTitle };
  // Always set, because gtag.js otherwise reads the raw `document.referrer`,
  // which for a full page load from one of our own tokenized pages is that
  // page's whole address.
  const referrer = lastPageLocation ?? entryReferrer;
  if (referrer) params.page_referrer = referrer;
  gtag('set', params);
  gtag('event', 'page_view');
  lastPageLocation = pageLocation;
}
