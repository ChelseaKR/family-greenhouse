/**
 * Small, first-party browser telemetry rail. It reports only sanitized error
 * summaries, the three Core Web Vitals, and a count of reports it could not
 * deliver, to our own API/CloudWatch account: no stack traces, user ids, URLs
 * with query strings, or user-entered data.
 *
 * The delivery path is the API this rail also reports failures of, which means
 * it cannot report an outage of that API while the outage is happening. What
 * it can do is refuse to pretend nothing was lost — see the delivery
 * bookkeeping below and issue #576.
 */
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const RELEASE = import.meta.env.VITE_GIT_SHA || undefined;
const SESSION_KEY = 'fg-telemetry-session';
const MAX_ERRORS_PER_SESSION = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type Rating = 'good' | 'needs-improvement' | 'poor';
type VitalName = 'LCP' | 'CLS' | 'INP';

let initialized = false;
let errorCount = 0;
let vitalsSent = false;
let inMemorySessionId: string | null = null;
const vitalValues: Partial<Record<VitalName, number>> = {};
let vitalRoute = '/';
let clsWindowValue = 0;
let clsWindowStart = -1;
let clsWindowEnd = -1;
const KNOWN_ERROR_NAMES = new Set([
  'ChunkLoadError',
  'Error',
  'EvalError',
  'NetworkError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

export function telemetryAllowed(): boolean {
  return typeof navigator === 'undefined' || navigator.doNotTrack !== '1';
}

function freshUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // Very old embedded webviews can lack Web Crypto. This id is only a
    // session-local de-duplication key, not a security token.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function telemetrySessionId(): string {
  if (inMemorySessionId) return inMemorySessionId;
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing && UUID_PATTERN.test(existing)) {
      inMemorySessionId = existing;
      return existing;
    }
    const created = freshUuid();
    sessionStorage.setItem(SESSION_KEY, created);
    inMemorySessionId = created;
    return created;
  } catch {
    inMemorySessionId = freshUuid();
    return inMemorySessionId;
  }
}

/** Collapse identifiers and secrets so cardinality stays bounded and routes
 * remain useful without exposing invite codes, UUIDs, or numeric ids. */
export function normalizeTelemetryRoute(input: string): string {
  const path = input.split(/[?#]/u, 1)[0] || '/';
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, '/:id')
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/gu, '/:token')
    .replace(/\/\d+(?=\/|$)/gu, '/:id')
    .slice(0, 180);
}

/** Remove common personal/secret-shaped values. The result is deliberately
 * short and never includes a stack trace. */
export function sanitizeTelemetryMessage(input: string): string {
  return (
    input
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[email]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, '[id]')
      .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/gu, '[token]')
      .replace(/\+\d{7,15}\b/gu, '[phone]')
      .replace(/https?:\/\/\S+/gu, '[url]')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 240) || 'Unknown browser error'
  );
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Delivery bookkeeping (issue #576).
 *
 * The old `send()` was `void fetch(...).catch(() => {})`: the rejection was
 * discarded and the resolved case was never inspected, so an unreachable API,
 * a CORS block, a renamed route and a 429 were all indistinguishable from a
 * clean delivery — and from each other. `FrontendErrors == 0` therefore meant
 * either "no browser errors" or "no browser could tell us", with nothing
 * anywhere able to say which. That is this repo's dominant defect class
 * (absence rendered as a value) sitting on the observability layer.
 *
 * A browser cannot fix its own unreachable API. What it can do is refuse to
 * destroy the evidence: count the reports that did not land, remember the
 * count across reloads, and hand it over the moment delivery works again. The
 * outage then leaves a trace — late, but real — instead of leaving nothing.
 *
 * `localStorage`, not `sessionStorage`: an app that broke badly enough to lose
 * its telemetry is an app the visitor probably closed. The counter has to
 * outlive the tab to be worth keeping at all. Both are wrapped in try/catch —
 * Safari private mode throws on write, and a lost counter must never break the
 * page it is reporting about.
 *
 * Nothing is stored under Do Not Track: every path here is reached only
 * through `send()`, which returns early when `telemetryAllowed()` is false.
 */
const UNDELIVERED_KEY = 'fg-telemetry-undelivered';
const MAX_UNDELIVERED = 9999;
/** 14 days, matching the schema bound in backend/src/models/telemetry.ts. */
const MAX_UNDELIVERED_AGE_MINUTES = 20_160;

interface UndeliveredRecord {
  /** Reports that failed to reach the API. Never a payload — only a count. */
  count: number;
  /** Epoch ms of the FIRST loss in this streak, so age is reportable. */
  since: number;
}

let deliveryReportInFlight = false;

function readUndelivered(): UndeliveredRecord | null {
  try {
    const raw = localStorage.getItem(UNDELIVERED_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { count, since } = parsed as Partial<UndeliveredRecord>;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) return null;
    if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) return null;
    return { count: Math.min(Math.trunc(count), MAX_UNDELIVERED), since };
  } catch {
    // Unavailable storage or a hand-edited value. Treat as "nothing pending"
    // rather than throwing inside an error handler.
    return null;
  }
}

function writeUndelivered(record: UndeliveredRecord | null): void {
  try {
    if (record === null) localStorage.removeItem(UNDELIVERED_KEY);
    else localStorage.setItem(UNDELIVERED_KEY, JSON.stringify(record));
  } catch {
    // Quota, private mode, or storage disabled. Best-effort by design.
  }
}

function recordUndelivered(): void {
  const existing = readUndelivered();
  writeUndelivered({
    count: Math.min((existing?.count ?? 0) + 1, MAX_UNDELIVERED),
    since: existing?.since ?? Date.now(),
  });
}

/** Subtract what we just successfully reported, keeping anything newer. */
function clearReportedLosses(reported: number): void {
  const current = readUndelivered();
  if (!current) return;
  const remaining = current.count - reported;
  writeUndelivered(remaining > 0 ? { count: remaining, since: Date.now() } : null);
}

/**
 * Tell the API that reports were lost, if any were. Sent on init and again
 * after any successful report, because those are the two moments we have
 * evidence that delivery works right now.
 *
 * A failed delivery report does NOT increment the counter. It is a report
 * ABOUT losses, not a new loss, and counting it would let the number grow by
 * one per page load for as long as an outage lasts — turning a measure of how
 * much was lost into a measure of how often we retried.
 */
function flushUndelivered(): void {
  // The same guards `send()` applies, checked here too: `send()` returning
  // early would otherwise leave the in-flight latch stuck true forever, and a
  // latch that can only be set is a rail that reports once and then stops.
  if (deliveryReportInFlight || !telemetryAllowed() || typeof fetch === 'undefined') return;
  const record = readUndelivered();
  if (!record) return;
  deliveryReportInFlight = true;
  const ageMinutes = Math.min(
    Math.max(Math.round((Date.now() - record.since) / 60_000), 0),
    MAX_UNDELIVERED_AGE_MINUTES
  );
  send(
    {
      kind: 'delivery',
      source: 'browser',
      sessionId: telemetrySessionId(),
      route: normalizeTelemetryRoute(globalThis.location?.pathname ?? '/'),
      undelivered: record.count,
      ageMinutes,
      ...(RELEASE ? { release: RELEASE } : {}),
    },
    'delivery'
  );
}

type SendKind = 'report' | 'delivery';

function send(payload: Record<string, unknown>, kind: SendKind = 'report'): void {
  if (!telemetryAllowed() || typeof fetch === 'undefined') return;
  void deliver(payload, kind);
}

async function deliver(payload: Record<string, unknown>, kind: SendKind): Promise<void> {
  let delivered: boolean;
  try {
    const response = await fetch(`${API_URL}/telemetry/frontend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    // A resolved fetch is not a delivered report: a 404 from a renamed route,
    // a 400 from a schema change and a 429 from the rate limiter all resolve.
    delivered = response?.ok === true;
  } catch {
    // Network unreachable, DNS/TLS failure, or the opaque TypeError a CORS
    // block produces. The browser is never told which; the count is the only
    // thing we can honestly record.
    delivered = false;
  }

  if (kind === 'delivery') {
    deliveryReportInFlight = false;
    const reported = typeof payload.undelivered === 'number' ? payload.undelivered : 0;
    if (delivered) clearReportedLosses(reported);
    return;
  }

  if (delivered) flushUndelivered();
  else recordUndelivered();
}

export function reportFrontendError(error: unknown): void {
  if (!telemetryAllowed() || errorCount >= MAX_ERRORS_PER_SESSION) return;
  errorCount += 1;
  const source = error instanceof Error ? error : new Error(String(error));
  const name = KNOWN_ERROR_NAMES.has(source.name) ? source.name : 'Error';
  const redacted = sanitizeTelemetryMessage(source.message);
  const message = /chunk|dynamically imported module|module script/iu.test(redacted)
    ? 'Application update or chunk load failed'
    : /fetch|network|load failed/iu.test(redacted)
      ? 'Network request failed'
      : `${name} in browser`;
  const route = normalizeTelemetryRoute(globalThis.location?.pathname ?? '/');
  send({
    kind: 'error',
    sessionId: telemetrySessionId(),
    route,
    name,
    message,
    fingerprint: fingerprint(`${name}:${message}:${route}`),
    ...(RELEASE ? { release: RELEASE } : {}),
  });
}

function rating(metric: VitalName, value: number): Rating {
  const [good, poor] =
    metric === 'CLS' ? [0.1, 0.25] : metric === 'INP' ? [200, 500] : [2500, 4000];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

function sendVitals(): void {
  if (vitalsSent) return;
  vitalsSent = true;
  for (const metric of ['LCP', 'CLS', 'INP'] as const) {
    const value = vitalValues[metric];
    if (value === undefined) continue;
    send({
      kind: 'vital',
      sessionId: telemetrySessionId(),
      route: vitalRoute,
      metric,
      value: Math.round(value * 1000) / 1000,
      rating: rating(metric, value),
      ...(RELEASE ? { release: RELEASE } : {}),
    });
  }
}

function observeVitals(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (supported.includes('largest-contentful-paint')) {
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) vitalValues.LCP = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  }
  if (supported.includes('layout-shift')) {
    vitalValues.CLS = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
        if (shift.hadRecentInput) continue;
        if (
          clsWindowStart < 0 ||
          shift.startTime - clsWindowEnd > 1000 ||
          shift.startTime - clsWindowStart > 5000
        ) {
          clsWindowValue = shift.value ?? 0;
          clsWindowStart = shift.startTime;
        } else {
          clsWindowValue += shift.value ?? 0;
        }
        clsWindowEnd = shift.startTime;
        vitalValues.CLS = Math.max(vitalValues.CLS ?? 0, clsWindowValue);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  }
  if (supported.includes('event')) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const event = entry as PerformanceEntry & { duration: number; interactionId?: number };
        if ((event.interactionId ?? 0) > 0) {
          vitalValues.INP = Math.max(vitalValues.INP ?? 0, event.duration);
        }
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
  }
}

export function initFrontendTelemetry(): void {
  if (initialized || !telemetryAllowed() || typeof window === 'undefined') return;
  initialized = true;
  vitalRoute = normalizeTelemetryRoute(globalThis.location?.pathname ?? '/');
  window.addEventListener('error', (event) => reportFrontendError(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => reportFrontendError(event.reason));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendVitals();
  });
  window.addEventListener('pagehide', sendVitals, { once: true });
  observeVitals();
  // Hand over anything a previous session could not deliver. If the API is
  // still unreachable this fails quietly and the count survives for next time.
  flushUndelivered();
}
