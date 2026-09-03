/**
 * Sentry, loaded only when a DSN is configured — and only when the browser has
 * not asked not to be tracked.
 *
 * `import.meta.env.VITE_SENTRY_DSN` is inlined by Vite at build time. When it's
 * unset (the current prod build has no DSN), the `if` below is dead code and
 * Rollup tree-shakes the dynamic `import('@sentry/react')` away entirely — the
 * ~35 KB SDK never ships. When a DSN *is* present at build, Sentry loads as a
 * lazy chunk fetched right after mount, so it stays out of the initial bundle.
 *
 * This replaces a static top-level `import * as Sentry` that shipped the SDK to
 * every user regardless of DSN.
 *
 * Privacy posture — the privacy page's Sentry paragraph says a crash report
 * carries the stack trace and browsing breadcrumbs, and this module is what
 * makes that the whole truth:
 *
 *  - Do Not Track suppresses Sentry through the same `telemetryAllowed()`
 *    predicate the first-party rail uses (`services/frontendTelemetry.ts`), so
 *    the two signals cannot drift. A DSN set later does not change this.
 *  - `sendDefaultPii` is left at its `false` default; its v10 successor
 *    `dataCollection` is set explicitly so every category that could carry a
 *    person or their content (user info, cookies, headers, bodies, query
 *    strings, local variables) is off by declaration, not by SDK default.
 *  - The SDK attaches `location.href` and the referrer to every event and puts
 *    full URLs in fetch/navigation breadcrumbs. `/sit/<bearer token>` and
 *    `/join/<invite code>` are real routes here, so URLs are reduced to the
 *    first-party rail's normalized route (`:id` / `:token` placeholders, no
 *    query string) before they leave the browser.
 *  - Error messages pass through the rail's sanitizer (emails, ids, tokens,
 *    phones, URLs). Console output is not a browsing breadcrumb and is dropped.
 *  - Session replay is never armed. The DPIA and the analytics shim both
 *    promise no session recordings, so both replay rates are pinned to 0 and
 *    adding the replay integration later cannot quietly turn recording on.
 */
import type { Breadcrumb, BrowserOptions, ErrorEvent } from '@sentry/react';
import {
  normalizeTelemetryRoute,
  sanitizeTelemetryMessage,
  telemetryAllowed,
} from './services/frontendTelemetry';

type DataCollection = NonNullable<BrowserOptions['dataCollection']>;

/** Every collection category that could carry identity or user content, off. */
export const SENTRY_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
  stackFrameVariables: false,
};

/**
 * Route-only form of a URL. The origin is kept when there is one (it names
 * which API a failed fetch was talking to); the path is collapsed through the
 * first-party rail's normalizer so ids, invite codes, and sitter tokens become
 * placeholders; query string and fragment are dropped. Non-strings pass through
 * untouched so a breadcrumb the SDK built without a URL is not corrupted.
 */
export function scrubSentryUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${normalizeTelemetryRoute(url.pathname)}`;
    }
  } catch {
    // Relative URL — normalize it as a route.
  }
  return normalizeTelemetryRoute(value);
}

/**
 * `beforeSend`: keep the stack trace, drop everything that describes the
 * person. Runs after the SDK's own integrations have enriched the event, so it
 * sees the `request` block the HttpContext integration adds.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  // Nothing here calls `Sentry.setUser`, and `dataCollection.userInfo` is off;
  // this makes sure a future call cannot re-attach an identity either.
  delete event.user;
  if (event.request) {
    const userAgent = event.request.headers?.['User-Agent'];
    event.request = {
      ...(event.request.url ? { url: scrubSentryUrl(event.request.url) as string } : {}),
      // User-Agent is what Sentry parses browser/OS from; Referer is dropped.
      ...(userAgent ? { headers: { 'User-Agent': userAgent } } : {}),
    };
  }
  if (event.message) event.message = sanitizeTelemetryMessage(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = sanitizeTelemetryMessage(exception.value);
  }
  return event;
}

/**
 * `beforeBreadcrumb`: browsing breadcrumbs (clicks, navigations, requests)
 * stay, with their URLs reduced to routes. Console breadcrumbs are dropped —
 * they would carry whatever the app happened to `console.warn`, which is not
 * what the privacy page describes.
 */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null;
  const data = breadcrumb.data;
  if (!data) return breadcrumb;
  for (const key of ['url', 'from', 'to'] as const) {
    if (key in data) data[key] = scrubSentryUrl(data[key]);
  }
  return breadcrumb;
}

export async function initSentry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  // Same signal, same predicate as initFrontendTelemetry(): a browser that
  // sends DNT: 1 gets no crash reporting either.
  if (!telemetryAllowed()) return;

  const Sentry = await import('@sentry/react');
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_GIT_SHA as string | undefined,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
}
