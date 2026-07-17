/**
 * Small, first-party browser telemetry rail. It reports only sanitized error
 * summaries and the three Core Web Vitals to our own API/CloudWatch account:
 * no stack traces, user ids, URLs with query strings, or user-entered data.
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

function telemetryAllowed(): boolean {
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

function send(payload: Record<string, unknown>): void {
  if (!telemetryAllowed() || typeof fetch === 'undefined') return;
  void fetch(`${API_URL}/telemetry/frontend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
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
}
