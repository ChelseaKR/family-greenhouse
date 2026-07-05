import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import type { AuthenticatedEvent } from './auth.js';
import { audit } from '../utils/auditLog.js';

/**
 * Lightweight in-memory rate limiter, scoped to the source IP. Designed as a
 * defence-in-depth complement to API Gateway throttling — under normal
 * traffic API Gateway is the primary limiter, but if it's misconfigured or
 * disabled in a stage, this still keeps `/auth/*` from being brute-forced.
 *
 * IMPORTANT — limits are PER WARM CONTAINER, not global. Lambda containers
 * don't share memory, so the effective limit multiplies with concurrency:
 * with N warm containers an attacker can get up to N × `max` requests per
 * window (and a brand-new container starts with empty buckets). Treat these
 * numbers as a brake on a single hot connection, not a hard global cap. For
 * a global limit, swap the in-memory Maps for DDB conditional updates.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const userBuckets = new Map<string, Bucket>();

/**
 * Opportunistic eviction so the Maps don't grow unbounded over a container's
 * lifetime (each unique IP|path or user|path key adds an entry that would
 * otherwise live forever). Every `SWEEP_EVERY_N_CALLS` checks — or sooner if
 * a map is unusually large — we drop every expired bucket. Amortized O(1).
 */
const SWEEP_EVERY_N_CALLS = 256;
const SWEEP_SIZE_THRESHOLD = 5_000;
const sweepCounters = new WeakMap<Map<string, Bucket>, number>();

function maybeSweep(map: Map<string, Bucket>, now: number): void {
  const calls = (sweepCounters.get(map) ?? 0) + 1;
  if (calls < SWEEP_EVERY_N_CALLS && map.size <= SWEEP_SIZE_THRESHOLD) {
    sweepCounters.set(map, calls);
    return;
  }
  sweepCounters.set(map, 0);
  for (const [key, bucket] of map) {
    if (bucket.resetAt <= now) map.delete(key);
  }
}

/**
 * Take one token from `key`'s bucket. Returns false when the bucket is
 * exhausted for the current window.
 */
function takeToken(
  map: Map<string, Bucket>,
  key: string,
  opts: { perWindowMs: number; max: number }
): boolean {
  const now = Date.now();
  maybeSweep(map, now);
  const existing = map.get(key);
  if (!existing || existing.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + opts.perWindowMs });
    return true;
  }
  if (existing.count >= opts.max) {
    return false;
  }
  existing.count += 1;
  return true;
}

/**
 * HTTP API v2 (payload format 2.0) puts the connection IP at
 * `requestContext.http.sourceIp` and the path at `rawPath`; REST/v1 events
 * use `requestContext.identity.sourceIp` and `path`. Support both, v2 first
 * (this API runs behind an HTTP API).
 */
interface MaybeV2Event {
  rawPath?: string;
  requestContext?: {
    http?: { sourceIp?: string };
    identity?: { sourceIp?: string };
  };
}

function sourceIp(event: APIGatewayProxyEvent): string {
  // SECURITY: identity must come from the connection-derived sourceIp that
  // API Gateway stamps on the request context — clients cannot forge it.
  // Never derive identity from X-Forwarded-For: its leftmost hop is set by
  // the client, so honoring it lets an attacker mint a fresh bucket per
  // request and bypass the limiter entirely.
  const rc = event.requestContext as unknown as MaybeV2Event['requestContext'];
  return rc?.http?.sourceIp ?? rc?.identity?.sourceIp ?? 'unknown';
}

interface MaybeRoutedEvent {
  routeKey?: string;
  resource?: string;
  httpMethod?: string;
}

// Bucket on the route TEMPLATE API Gateway resolved (e.g.
// "GET /species/{id}/guide"), not the literal request path — otherwise every
// distinct numeric id on an `{id}`-shaped route gets its own bucket, and
// varying the id trivially defeats a documented "N per minute" cap. Mirrors
// the same resolution `router.ts`'s `routeKeyFor` uses for dispatch.
//
// Falls back to the literal path when neither `routeKey` (HTTP API v2) nor a
// real `resource` (REST API v1) is present — routes with no `{param}` segment
// (e.g. /auth/login vs /auth/refresh) are already distinct paths with nothing
// to conflate, so the fallback stays correct for them.
function routePath(event: APIGatewayProxyEvent): string {
  const routed = event as MaybeRoutedEvent;
  if (typeof routed.routeKey === 'string') return routed.routeKey;
  if (typeof routed.resource === 'string' && routed.resource !== '/') {
    return `${routed.httpMethod ?? 'GET'} ${routed.resource}`;
  }
  return (event as MaybeV2Event).rawPath ?? event.path ?? '/';
}

export function rateLimit(opts: {
  perWindowMs: number;
  max: number;
}): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = (request) => {
    // Key on route + IP so a flood on /auth/login doesn't lock the same IP
    // out of /auth/refresh.
    const key = `${routePath(request.event)}|${sourceIp(request.event)}`;
    if (!takeToken(buckets, key, opts)) {
      // `actorId` populated when this fires after `authMiddleware`. For pre-auth
      // routes (login, signup, validateInvite) the bucket key is the only
      // identifier we have — that's still useful for forensics when correlated
      // to the access log's sourceIp + requestId.
      const actorId = (request.event as AuthenticatedEvent).user?.userId;
      audit('rate_limit.tripped', { actorId, metadata: { key } });
      throw createHttpError(429, 'Too many requests. Please slow down and try again.');
    }
  };
  return { before };
}

/**
 * Apply tight limits on auth endpoints. 10 attempts/minute per IP per route is
 * generous for legitimate humans (typing a wrong password 10 times in a minute
 * would already trigger the user's own re-think) and harshly slows down a
 * credential-stuffing bot. Per-warm-container — see module doc.
 */
export const authRateLimit = () => rateLimit({ perWindowMs: 60_000, max: 10 });

/**
 * Test hook — drops every in-memory rate-limit bucket. Production code never
 * calls this; it exists so handler unit tests can run many sequential
 * requests against the same IP without tripping the 10/min auth limit.
 */
export function __resetRateLimitForTests(): void {
  buckets.clear();
  userBuckets.clear();
  sweepCounters.set(buckets, 0);
  sweepCounters.set(userBuckets, 0);
}

/** Test hook — bucket counts, so eviction behavior can be asserted. */
export function __rateLimitBucketCountsForTests(): { ip: number; user: number } {
  return { ip: buckets.size, user: userBuckets.size };
}

/**
 * Per-user rate limiter for write-side endpoints. Sits *after* the auth
 * middleware so we have an authenticated user id; falls open (no limit)
 * if somehow there isn't one — that path should already be 401'd before
 * we get here.
 *
 * Defaults are budgeted around realistic human use: 60 writes/minute is
 * roughly a mutation every second sustained for a full minute, well above
 * any legitimate UI-driven workload but tight enough to stop a runaway
 * client looping.
 *
 * In-memory and per-warm-container, same caveat as `rateLimit`: the
 * effective ceiling multiplies with Lambda concurrency. For a global limit
 * swap the Map for a DDB conditional update.
 */
export function userRateLimit(
  opts: { perWindowMs: number; max: number } = { perWindowMs: 60_000, max: 60 }
): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = (request) => {
    const userId = (request.event as AuthenticatedEvent).user?.userId;
    if (!userId) return;
    const key = `${routePath(request.event)}|${userId}`;
    if (!takeToken(userBuckets, key, opts)) {
      audit('rate_limit.tripped', { actorId: userId, metadata: { key } });
      throw createHttpError(429, 'Too many requests. Please slow down and try again.');
    }
  };
  return { before };
}
