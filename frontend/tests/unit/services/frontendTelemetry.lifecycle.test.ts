/**
 * Lifecycle half of the first-party telemetry rail: init wiring, the Core Web
 * Vitals observers (including the CLS session-window rule), the flush-once
 * contract, and the per-session error cap. The sanitizer/route-normalizer half
 * lives in `src/services/frontendTelemetry.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ObserverInit = { type: string; buffered?: boolean; durationThreshold?: number };
type Entry = Record<string, unknown>;

/** Fake PerformanceObserver that lets a test push entries per entry type. */
class FakePerformanceObserver {
  static supportedEntryTypes: string[] = ['largest-contentful-paint', 'layout-shift', 'event'];
  static byType = new Map<string, FakePerformanceObserver[]>();

  constructor(private readonly callback: (list: { getEntries: () => Entry[] }) => void) {}

  observe(init: ObserverInit) {
    const existing = FakePerformanceObserver.byType.get(init.type) ?? [];
    existing.push(this);
    FakePerformanceObserver.byType.set(init.type, existing);
  }

  disconnect() {}

  static emit(type: string, entries: Entry[]) {
    for (const observer of FakePerformanceObserver.byType.get(type) ?? []) {
      observer.callback({ getEntries: () => entries });
    }
  }
}

function bodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * jsdom's window/document are shared by every test in this file, so listeners
 * an earlier `initFrontendTelemetry()` registered would otherwise still fire
 * against a later test's fetch stub. Record what each test registers and tear
 * it down afterwards so every case observes only its own module instance.
 */
const registered: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

function trackListeners(target: EventTarget) {
  const original = target.addEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
    if (listener) registered.push([target, type, listener]);
    original(type, listener, options);
  });
}

beforeEach(() => {
  vi.resetModules();
  trackListeners(window);
  trackListeners(document);
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  sessionStorage.clear();
  history.replaceState({}, '', '/dashboard');
  Object.defineProperty(globalThis.navigator, 'doNotTrack', { value: null, configurable: true });
  FakePerformanceObserver.byType = new Map();
  FakePerformanceObserver.supportedEntryTypes = [
    'largest-contentful-paint',
    'layout-shift',
    'event',
  ];
  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [target, type, listener] of registered) target.removeEventListener(type, listener);
  registered.length = 0;
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

function hidePage() {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('initFrontendTelemetry', () => {
  it('reports window errors and unhandled rejections through the sanitized rail', async () => {
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();

    window.dispatchEvent(
      new ErrorEvent('error', { error: new TypeError('boom for person@example.com') })
    );
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new RangeError('out of range');
    window.dispatchEvent(rejection);

    const sent = bodies(fetchMock);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ kind: 'error', name: 'TypeError', route: '/dashboard' });
    expect(JSON.stringify(sent[0])).not.toContain('person@example.com');
    expect(sent[1]).toMatchObject({ name: 'RangeError' });
  });

  it('is idempotent — a second init does not double-register listeners', async () => {
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();
    initFrontendTelemetry();

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('once') }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing under Do Not Track', async () => {
    Object.defineProperty(globalThis.navigator, 'doNotTrack', { value: '1', configurable: true });
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();

    FakePerformanceObserver.emit('largest-contentful-paint', [{ startTime: 1200 }]);
    hidePage();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('error reporting', () => {
  it('classifies chunk-load and network failures into stable buckets', async () => {
    const { reportFrontendError } = await import('@/services/frontendTelemetry');

    reportFrontendError(new Error('Failed to fetch dynamically imported module'));
    reportFrontendError(new Error('NetworkError when attempting to fetch resource'));
    reportFrontendError(new Error('something else entirely'));

    expect(bodies(fetchMock).map((body) => body.message)).toEqual([
      'Application update or chunk load failed',
      'Network request failed',
      'Error in browser',
    ]);
  });

  it('coerces an unknown error name to Error and stringifies non-Errors', async () => {
    const { reportFrontendError } = await import('@/services/frontendTelemetry');
    const custom = new Error('weird');
    custom.name = 'MySpecialError';

    reportFrontendError(custom);
    reportFrontendError('a bare string failure');

    const sent = bodies(fetchMock);
    expect(sent[0].name).toBe('Error');
    expect(sent[1]).toMatchObject({ name: 'Error', message: 'Error in browser' });
  });

  it('caps errors per session so a render loop cannot flood the endpoint', async () => {
    const { reportFrontendError } = await import('@/services/frontendTelemetry');

    for (let i = 0; i < 25; i += 1) reportFrontendError(new Error(`boom ${i}`));

    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('gives identical route+message errors the same fingerprint', async () => {
    const { reportFrontendError } = await import('@/services/frontendTelemetry');

    reportFrontendError(new Error('first'));
    reportFrontendError(new Error('second'));

    const sent = bodies(fetchMock);
    expect(sent[0].fingerprint).toBe(sent[1].fingerprint);
    expect(sent[0].fingerprint).toMatch(/^[0-9a-f]{8}$/u);
  });
});

describe('core web vitals', () => {
  it('flushes LCP, CLS, and INP once when the page is hidden', async () => {
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();

    FakePerformanceObserver.emit('largest-contentful-paint', [
      { startTime: 900 },
      { startTime: 3100.4567 },
    ]);
    FakePerformanceObserver.emit('layout-shift', [{ startTime: 100, value: 0.05 }]);
    FakePerformanceObserver.emit('event', [
      { startTime: 10, duration: 180, interactionId: 7 },
      { startTime: 20, duration: 40, interactionId: 0 },
    ]);

    hidePage();
    hidePage();

    const sent = bodies(fetchMock);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      kind: 'vital',
      metric: 'LCP',
      value: 3100.457,
      rating: 'needs-improvement',
      route: '/dashboard',
    });
    expect(sent[1]).toMatchObject({ metric: 'CLS', value: 0.05, rating: 'good' });
    expect(sent[2]).toMatchObject({ metric: 'INP', value: 180, rating: 'good' });
  });

  it('flushes on pagehide for browsers that never fire visibilitychange', async () => {
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();
    FakePerformanceObserver.emit('largest-contentful-paint', [{ startTime: 5000 }]);

    window.dispatchEvent(new Event('pagehide'));

    expect(bodies(fetchMock)[0]).toMatchObject({ metric: 'LCP', rating: 'poor' });
  });

  it('reports the worst CLS session window, not the lifetime sum', async () => {
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();

    // Three shifts inside one session window, then a shift after a >1s gap
    // opens a new (smaller) window. The reported value is the worst window.
    FakePerformanceObserver.emit('layout-shift', [
      { startTime: 100, value: 0.04 },
      { startTime: 500, value: 0.04 },
      { startTime: 900, value: 0.04 },
      { startTime: 4000, value: 0.02 },
    ]);
    hidePage();

    expect(bodies(fetchMock)[0]).toMatchObject({ metric: 'CLS', value: 0.12 });
  });

  it('starts a new CLS window once five seconds have elapsed', async () => {
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();

    FakePerformanceObserver.emit('layout-shift', [
      { startTime: 0, value: 0.3 },
      { startTime: 500, value: 0.3 },
      { startTime: 5600, value: 0.1 },
    ]);
    hidePage();

    expect(bodies(fetchMock)[0]).toMatchObject({ metric: 'CLS', value: 0.6, rating: 'poor' });
  });

  it('ignores layout shifts that follow recent user input', async () => {
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();

    FakePerformanceObserver.emit('layout-shift', [
      { startTime: 100, value: 0.5, hadRecentInput: true },
    ]);
    hidePage();

    expect(bodies(fetchMock)[0]).toMatchObject({ metric: 'CLS', value: 0 });
  });

  it('skips observers the browser does not support and sends no vital for them', async () => {
    FakePerformanceObserver.supportedEntryTypes = [];
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');
    initFrontendTelemetry();

    hidePage();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tolerates a browser with no PerformanceObserver at all', async () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const { initFrontendTelemetry } = await import('@/services/frontendTelemetry');

    expect(() => initFrontendTelemetry()).not.toThrow();
    hidePage();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('session id', () => {
  it('falls back to an in-memory id when sessionStorage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const { telemetrySessionId } = await import('@/services/frontendTelemetry');

    const first = telemetrySessionId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    );
    expect(telemetrySessionId()).toBe(first);
    getItem.mockRestore();
  });

  it('builds a v4 id without crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab);
        return bytes;
      },
    });
    const { telemetrySessionId } = await import('@/services/frontendTelemetry');

    expect(telemetrySessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    );
  });

  it('builds a v4 id with no Web Crypto at all', async () => {
    vi.stubGlobal('crypto', undefined);
    const { telemetrySessionId } = await import('@/services/frontendTelemetry');

    expect(telemetrySessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    );
  });
});
