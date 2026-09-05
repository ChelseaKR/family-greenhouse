import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  sessionStorage.clear();
  // The undelivered-report counter lives in localStorage on purpose (it has to
  // outlive the tab). Clear it between tests so a delivery failure in one does
  // not make the next one send an extra delivery report.
  localStorage.clear();
  history.replaceState({}, '', '/plants/123e4567-e89b-12d3-a456-426614174000?secret=yes');
  Object.defineProperty(globalThis.navigator, 'doNotTrack', {
    value: null,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('first-party frontend telemetry', () => {
  it('normalizes route identifiers and removes query strings', async () => {
    const { normalizeTelemetryRoute } = await import('./frontendTelemetry');
    expect(
      normalizeTelemetryRoute(
        '/households/123e4567-e89b-12d3-a456-426614174000/plants/42?invite=secret'
      )
    ).toBe('/households/:id/plants/:id');
    expect(normalizeTelemetryRoute('/join/abcdefghijklmnopqrstuvwxyz123456')).toBe('/join/:token');
  });

  it('redacts personal and secret-shaped values from error summaries', async () => {
    const { sanitizeTelemetryMessage } = await import('./frontendTelemetry');
    const sanitized = sanitizeTelemetryMessage(
      'Failed for person@example.com +15551234567 Bearer abcdefghijklmnopqrstuvwxyz at https://example.com/private?q=1'
    );
    expect(sanitized).toContain('[email]');
    expect(sanitized).toContain('[phone]');
    expect(sanitized).toContain('[token]');
    expect(sanitized).toContain('[url]');
    expect(sanitized).not.toContain('person@example.com');
  });

  it('replaces a malformed stored session id and reuses the valid result', async () => {
    sessionStorage.setItem('fg-telemetry-session', 'not-a-uuid');
    const { telemetrySessionId } = await import('./frontendTelemetry');
    const first = telemetrySessionId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    );
    expect(telemetrySessionId()).toBe(first);
    expect(sessionStorage.getItem('fg-telemetry-session')).toBe(first);
  });

  it('reports a bounded, sanitized error without a stack trace', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { reportFrontendError } = await import('./frontendTelemetry');

    reportFrontendError(new Error('Account person@example.com token abcdefghijklmnopqrstuvwxyz'));
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/telemetry/frontend');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'error', route: '/plants/:id', name: 'Error' });
    expect(body.message).toBe('Error in browser');
    expect(body.message).not.toContain('person@example.com');
    expect(body).not.toHaveProperty('stack');
    expect(body.fingerprint).toMatch(/^[a-f0-9]{8}$/u);
  });

  it('honors Do Not Track', async () => {
    Object.defineProperty(globalThis.navigator, 'doNotTrack', {
      value: '1',
      configurable: true,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { reportFrontendError } = await import('./frontendTelemetry');
    reportFrontendError(new Error('nope'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Issue #576. The rail posts to the API it exists to report failures of, so
 * these are the cases where the old `.catch(() => {})` destroyed the evidence:
 * the report vanished, `FrontendErrors` stayed at zero, and zero was already
 * what a healthy quiet window looked like.
 */
describe('delivery failures are counted, not swallowed', () => {
  const UNDELIVERED_KEY = 'fg-telemetry-undelivered';

  /** Let the async delivery path settle. */
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };

  it('records an unreachable API instead of discarding the report', async () => {
    // What a CORS block and an unreachable host both look like to fetch.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { reportFrontendError } = await import('./frontendTelemetry');

    reportFrontendError(new Error('first'));
    reportFrontendError(new Error('second'));
    await settle();

    const stored = JSON.parse(localStorage.getItem(UNDELIVERED_KEY) ?? 'null') as {
      count: number;
      since: number;
    } | null;
    expect(stored?.count).toBe(2);
    expect(stored?.since).toBeGreaterThan(0);
  });

  it('treats a resolved-but-not-ok response as undelivered', async () => {
    // A renamed route, added auth, a drifted schema, or the rate limiter. The
    // old sender never read `ok`, so all of these looked like a delivery.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const { reportFrontendError } = await import('./frontendTelemetry');

    reportFrontendError(new Error('boom'));
    await settle();

    const stored = JSON.parse(localStorage.getItem(UNDELIVERED_KEY) ?? 'null') as {
      count: number;
    } | null;
    expect(stored?.count).toBe(1);
  });

  it('hands the count over on the next successful send and then clears it', async () => {
    localStorage.setItem(
      UNDELIVERED_KEY,
      JSON.stringify({ count: 7, since: Date.now() - 3 * 60_000 })
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { reportFrontendError } = await import('./frontendTelemetry');

    reportFrontendError(new Error('now working'));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, deliveryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(deliveryInit.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'delivery', source: 'browser', undelivered: 7 });
    expect(body.ageMinutes).toBe(3);
    // No payload of a lost report is retained — only how many and how long.
    expect(body).not.toHaveProperty('message');
    expect(localStorage.getItem(UNDELIVERED_KEY)).toBeNull();
  });

  it('reports a previous session losses at init, before any new error happens', async () => {
    localStorage.setItem(
      UNDELIVERED_KEY,
      JSON.stringify({ count: 5, since: Date.now() - 30 * 60_000 })
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { initFrontendTelemetry } = await import('./frontendTelemetry');

    initFrontendTelemetry();
    await settle();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'delivery', source: 'browser', undelivered: 5 });
    expect(body.ageMinutes).toBe(30);
    expect(localStorage.getItem(UNDELIVERED_KEY)).toBeNull();
  });

  it('does not inflate the count when the delivery report itself fails', async () => {
    localStorage.setItem(UNDELIVERED_KEY, JSON.stringify({ count: 4, since: Date.now() }));
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const { initFrontendTelemetry } = await import('./frontendTelemetry');

    initFrontendTelemetry();
    await settle();

    // The attempt has to have happened — otherwise "the count is still 4"
    // passes just as well when nothing tried to report it at all.
    expect(fetchMock).toHaveBeenCalledOnce();
    // Still 4. A report ABOUT losses is not itself a new loss; counting it
    // would turn "how much was lost" into "how often we retried".
    const stored = JSON.parse(localStorage.getItem(UNDELIVERED_KEY) ?? 'null') as {
      count: number;
    } | null;
    expect(stored?.count).toBe(4);
  });

  it('stores nothing under Do Not Track', async () => {
    Object.defineProperty(globalThis.navigator, 'doNotTrack', {
      value: '1',
      configurable: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { reportFrontendError } = await import('./frontendTelemetry');

    reportFrontendError(new Error('nope'));
    await settle();

    expect(localStorage.getItem(UNDELIVERED_KEY)).toBeNull();
  });
});
