/**
 * The Sentry privacy posture: dark without a DSN, dark under Do Not Track
 * (same predicate as the first-party rail), and — when it does run — a crash
 * report carries the stack trace and route-only breadcrumbs, nothing that
 * describes the person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Breadcrumb, ErrorEvent } from '@sentry/react';

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@sentry/react', () => ({ init }));

const DSN = 'https://public@o1.ingest.sentry.io/1';
const TOKEN = 'a'.repeat(64);

function setDoNotTrack(value: string | null) {
  Object.defineProperty(globalThis.navigator, 'doNotTrack', { value, configurable: true });
}

beforeEach(() => {
  vi.resetModules();
  init.mockClear();
  setDoNotTrack(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('initSentry', () => {
  it('stays dark without a DSN', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const { initSentry } = await import('./sentry');
    await initSentry();
    expect(init).not.toHaveBeenCalled();
  });

  it('honours Do Not Track exactly like the first-party rail', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', DSN);
    setDoNotTrack('1');
    const { initSentry } = await import('./sentry');
    await initSentry();
    expect(init).not.toHaveBeenCalled();
  });

  it('initialises with every identity-bearing collection category off', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', DSN);
    const { initSentry, scrubSentryBreadcrumb, scrubSentryEvent } = await import('./sentry');
    await initSentry();

    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({
      dsn: DSN,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
      },
    });
    expect(options.sendDefaultPii).not.toBe(true);
    expect(options.beforeSend).toBe(scrubSentryEvent);
    expect(options.beforeBreadcrumb).toBe(scrubSentryBreadcrumb);
  });
});

describe('scrubSentryUrl', () => {
  it('keeps the origin and reduces the path to the rail’s normalized route', async () => {
    const { scrubSentryUrl } = await import('./sentry');
    expect(
      scrubSentryUrl('https://api.example.test/plants/123e4567-e89b-12d3-a456-426614174000?x=1#y')
    ).toBe('https://api.example.test/plants/:id');
    expect(scrubSentryUrl(`/sit/${TOKEN}?secret=yes`)).toBe('/sit/:token');
    expect(scrubSentryUrl('/tasks?filter=overdue')).toBe('/tasks');
    expect(scrubSentryUrl(undefined)).toBeUndefined();
    expect(scrubSentryUrl(42)).toBe(42);
  });
});

describe('scrubSentryEvent', () => {
  it('keeps the stack trace and drops identity, referrer, query strings, and tokens', async () => {
    const { scrubSentryEvent } = await import('./sentry');
    const frames = [{ filename: 'app.js', function: 'save', lineno: 1, colno: 2 }];
    const event = {
      type: undefined,
      user: { id: 'cognito-sub', email: 'person@example.com' },
      request: {
        url: `https://familygreenhouse.net/sit/${TOKEN}?from=email`,
        headers: {
          'User-Agent': 'Mozilla/5.0 test',
          Referer: 'https://mail.example.com/inbox?thread=42',
        },
      },
      message: 'Could not reach person@example.com',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'Failed for 123e4567-e89b-12d3-a456-426614174000 at https://x.test/p?q=1',
            stacktrace: { frames },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.request).toEqual({
      url: 'https://familygreenhouse.net/sit/:token',
      headers: { 'User-Agent': 'Mozilla/5.0 test' },
    });
    expect(scrubbed.message).toBe('Could not reach [email]');
    expect(scrubbed.exception?.values?.[0]).toMatchObject({
      type: 'TypeError',
      value: 'Failed for [id] at [url]',
      stacktrace: { frames },
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/person@example\.com|thread=42|a{64}|from=email/u);
  });

  it('passes an event without request or exception through unchanged', async () => {
    const { scrubSentryEvent } = await import('./sentry');
    const event = { type: undefined, message: 'plain' } as unknown as ErrorEvent;
    expect(scrubSentryEvent(event)).toEqual({ type: undefined, message: 'plain' });
  });
});

describe('scrubSentryBreadcrumb', () => {
  it('drops console output', async () => {
    const { scrubSentryBreadcrumb } = await import('./sentry');
    const crumb: Breadcrumb = {
      category: 'console',
      message: 'Push failed for person@example.com',
    };
    expect(scrubSentryBreadcrumb(crumb)).toBeNull();
  });

  it('reduces request and navigation URLs to routes', async () => {
    const { scrubSentryBreadcrumb } = await import('./sentry');
    const fetchCrumb: Breadcrumb = {
      category: 'fetch',
      data: {
        method: 'GET',
        url: 'https://api.example.test/plants/42?include=all',
        status_code: 500,
      },
    };
    expect(scrubSentryBreadcrumb(fetchCrumb)).toEqual({
      category: 'fetch',
      data: { method: 'GET', url: 'https://api.example.test/plants/:id', status_code: 500 },
    });

    const navCrumb: Breadcrumb = {
      category: 'navigation',
      data: { from: `/join/${TOKEN}`, to: '/welcome?mode=add' },
    };
    expect(scrubSentryBreadcrumb(navCrumb)).toEqual({
      category: 'navigation',
      data: { from: '/join/:token', to: '/welcome' },
    });
  });

  it('leaves click breadcrumbs (a DOM selector, no value) alone', async () => {
    const { scrubSentryBreadcrumb } = await import('./sentry');
    const crumb: Breadcrumb = { category: 'ui.click', message: 'button.primary > span' };
    expect(scrubSentryBreadcrumb(crumb)).toBe(crumb);
  });
});
