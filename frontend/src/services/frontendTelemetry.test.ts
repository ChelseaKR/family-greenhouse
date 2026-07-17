import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  sessionStorage.clear();
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
