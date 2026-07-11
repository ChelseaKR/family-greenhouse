import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  rateLimit,
  authRateLimit,
  userRateLimit,
  __resetRateLimitForTests,
  __rateLimitBucketCountsForTests,
} from '../../../src/middleware/rateLimit.js';

/**
 * Build an HTTP API v2 (payload format 2.0) shaped event: source IP lives at
 * `requestContext.http.sourceIp` and the path at `rawPath`. v1's
 * `requestContext.identity` / `path` are intentionally absent — the limiter
 * must work against the shape production actually sends.
 */
function v2Event(opts: {
  ip?: string;
  path?: string;
  headers?: Record<string, string>;
  user?: { userId: string };
}): APIGatewayProxyEvent {
  const event = {
    body: null,
    headers: opts.headers ?? {},
    isBase64Encoded: false,
    rawPath: opts.path ?? '/auth/login',
    requestContext: {
      http: { method: 'POST', path: opts.path ?? '/auth/login', sourceIp: opts.ip ?? '1.2.3.4' },
      requestId: 'req-1',
    },
  } as unknown as APIGatewayProxyEvent;
  if (opts.user) {
    (event as unknown as { user: { userId: string } }).user = opts.user;
  }
  return event;
}

function makeHandler(mw: middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult>) {
  const inner = vi.fn(async (): Promise<APIGatewayProxyResult> => ({
    statusCode: 200,
    body: '{}',
  }));
  return {
    invoke: middy(inner).use(mw) as never as (
      event: APIGatewayProxyEvent,
      context?: unknown
    ) => Promise<APIGatewayProxyResult>,
    inner,
  };
}

beforeEach(() => {
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rateLimit (per-IP)', () => {
  it('allows up to max requests per window from one IP, then 429s', async () => {
    const { invoke } = makeHandler(rateLimit({ perWindowMs: 60_000, max: 3 }));
    for (let i = 0; i < 3; i++) {
      const res = await invoke(v2Event({ ip: '9.9.9.9' }));
      expect(res.statusCode).toBe(200);
    }
    await expect(invoke(v2Event({ ip: '9.9.9.9' }))).rejects.toMatchObject({
      statusCode: 429,
      message: 'Too many requests. Please slow down and try again.',
    });
  });

  it('reads the source IP from the v2 requestContext.http shape (distinct IPs get distinct buckets)', async () => {
    const { invoke } = makeHandler(rateLimit({ perWindowMs: 60_000, max: 1 }));
    await invoke(v2Event({ ip: '10.0.0.1' }));
    // Same IP again → limited.
    await expect(invoke(v2Event({ ip: '10.0.0.1' }))).rejects.toMatchObject({ statusCode: 429 });
    // Different real source IP → its own bucket.
    const res = await invoke(v2Event({ ip: '10.0.0.2' }));
    expect(res.statusCode).toBe(200);
  });

  it('ignores X-Forwarded-For: spoofed values do NOT mint fresh buckets', async () => {
    const { invoke } = makeHandler(rateLimit({ perWindowMs: 60_000, max: 2 }));
    // Attacker rotates the client-controlled leftmost XFF hop on every
    // request while the real connection IP stays the same.
    await invoke(v2Event({ ip: '6.6.6.6', headers: { 'x-forwarded-for': '1.1.1.1' } }));
    await invoke(v2Event({ ip: '6.6.6.6', headers: { 'x-forwarded-for': '2.2.2.2' } }));
    await expect(
      invoke(v2Event({ ip: '6.6.6.6', headers: { 'X-Forwarded-For': '3.3.3.3' } }))
    ).rejects.toMatchObject({ statusCode: 429 });
    // And only one bucket was ever created for that IP+route.
    expect(__rateLimitBucketCountsForTests().ip).toBe(1);
  });

  it('keys per route so one path cannot exhaust another', async () => {
    const { invoke } = makeHandler(rateLimit({ perWindowMs: 60_000, max: 1 }));
    await invoke(v2Event({ ip: '7.7.7.7', path: '/auth/login' }));
    const res = await invoke(v2Event({ ip: '7.7.7.7', path: '/auth/refresh' }));
    expect(res.statusCode).toBe(200);
  });

  it('keys on the resolved route template, not the literal path, so varying an {id} cannot bypass the cap', async () => {
    const { invoke } = makeHandler(rateLimit({ perWindowMs: 60_000, max: 1 }));
    const eventForId = (id: string) => ({
      ...v2Event({ ip: '7.7.7.8', path: `/species/${id}/thumbnail` }),
      routeKey: 'GET /species/{id}/thumbnail',
    });
    await invoke(eventForId('1'));
    // A different numeric id on the SAME route must share the bucket.
    await expect(invoke(eventForId('2'))).rejects.toMatchObject({ statusCode: 429 });
  });

  it('resets the bucket after the window elapses', async () => {
    vi.useFakeTimers();
    const { invoke } = makeHandler(rateLimit({ perWindowMs: 60_000, max: 1 }));
    await invoke(v2Event({ ip: '8.8.8.8' }));
    await expect(invoke(v2Event({ ip: '8.8.8.8' }))).rejects.toMatchObject({ statusCode: 429 });
    vi.advanceTimersByTime(60_001);
    const res = await invoke(v2Event({ ip: '8.8.8.8' }));
    expect(res.statusCode).toBe(200);
  });

  it('evicts expired buckets opportunistically instead of growing forever', async () => {
    vi.useFakeTimers();
    const { invoke } = makeHandler(rateLimit({ perWindowMs: 60_000, max: 1000 }));
    // Create 50 buckets from distinct IPs…
    for (let i = 0; i < 50; i++) {
      await invoke(v2Event({ ip: `10.1.1.${i}` }));
    }
    expect(__rateLimitBucketCountsForTests().ip).toBe(50);
    // …let them all expire…
    vi.advanceTimersByTime(120_000);
    // …then drive enough calls through one fresh key to cross the sweep
    // cadence (sweep runs every 256 calls). 429s along the way are expected
    // and irrelevant — the sweep happens regardless of the verdict.
    for (let i = 0; i < 300; i++) {
      await invoke(v2Event({ ip: '172.16.0.1' })).catch(() => undefined);
    }
    // The 50 expired buckets are gone; only the active key remains.
    expect(__rateLimitBucketCountsForTests().ip).toBe(1);
  });

  it('429 response carries the standard shape through the error mapper', async () => {
    const { invoke } = makeHandler(rateLimit({ perWindowMs: 60_000, max: 1 }));
    await invoke(v2Event({ ip: '5.5.5.5' }));
    let caught: unknown;
    try {
      await invoke(v2Event({ ip: '5.5.5.5' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      statusCode: 429,
      expose: true,
      message: 'Too many requests. Please slow down and try again.',
    });
  });
});

describe('authRateLimit', () => {
  it('limits to 10/min per IP per route', async () => {
    const { invoke } = makeHandler(authRateLimit());
    for (let i = 0; i < 10; i++) {
      const res = await invoke(v2Event({ ip: '4.4.4.4' }));
      expect(res.statusCode).toBe(200);
    }
    await expect(invoke(v2Event({ ip: '4.4.4.4' }))).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('userRateLimit', () => {
  it('limits per authenticated user id', async () => {
    const { invoke } = makeHandler(userRateLimit({ perWindowMs: 60_000, max: 2 }));
    await invoke(v2Event({ ip: '1.1.1.1', user: { userId: 'user-1' } }));
    // Same user from a different IP shares the bucket.
    await invoke(v2Event({ ip: '2.2.2.2', user: { userId: 'user-1' } }));
    await expect(
      invoke(v2Event({ ip: '3.3.3.3', user: { userId: 'user-1' } }))
    ).rejects.toMatchObject({ statusCode: 429 });
    // A different user is unaffected.
    const res = await invoke(v2Event({ ip: '1.1.1.1', user: { userId: 'user-2' } }));
    expect(res.statusCode).toBe(200);
  });

  it('falls open when there is no authenticated user', async () => {
    const { invoke } = makeHandler(userRateLimit({ perWindowMs: 60_000, max: 1 }));
    for (let i = 0; i < 5; i++) {
      const res = await invoke(v2Event({ ip: '1.1.1.1' }));
      expect(res.statusCode).toBe(200);
    }
    expect(__rateLimitBucketCountsForTests().user).toBe(0);
  });

  it('keys on the resolved route template, not the literal path, so varying an {id} cannot bypass the cap', async () => {
    const { invoke } = makeHandler(userRateLimit({ perWindowMs: 60_000, max: 1 }));
    const eventForId = (id: string) => ({
      ...v2Event({ ip: '1.1.1.1', path: `/species/${id}/guide`, user: { userId: 'user-1' } }),
      routeKey: 'GET /species/{id}/guide',
    });
    await invoke(eventForId('1'));
    // Same user, same route template, different numeric id — must NOT get a
    // fresh bucket (that would let one user read every species' guide by
    // simply incrementing the id, defeating the documented 10/min cap).
    await expect(invoke(eventForId('2'))).rejects.toMatchObject({ statusCode: 429 });
  });
});
