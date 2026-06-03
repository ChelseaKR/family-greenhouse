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
 * Limitations: Lambda containers don't share state, so the bucket is
 * per-container. For a global limit, swap the in-memory Map for DDB
 * conditional updates. We don't do that today because the per-container
 * limit is already much tighter than what API Gateway gives us.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function clientKey(event: APIGatewayProxyEvent): string {
  // Prefer the X-Forwarded-For chain (CloudFront passes it) and fall back to
  // sourceIp on the request context. We hash on the route too so a flood on
  // /auth/login doesn't lock you out of /auth/refresh.
  const fwd = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
  const ip =
    (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') ||
    event.requestContext?.identity?.sourceIp ||
    'unknown';
  return `${event.path}|${ip}`;
}

export function rateLimit(opts: {
  perWindowMs: number;
  max: number;
}): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = (request) => {
    const key = clientKey(request.event);
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.perWindowMs });
      return;
    }
    if (existing.count >= opts.max) {
      audit('rate_limit.tripped', { metadata: { key } });
      throw createHttpError(429, 'Too many requests. Please slow down and try again.');
    }
    existing.count += 1;
  };
  return { before };
}

/**
 * Apply tight limits on auth endpoints. 10 attempts/minute per IP per route is
 * generous for legitimate humans (typing a wrong password 10 times in a minute
 * would already trigger the user's own re-think) and harshly slows down a
 * credential-stuffing bot.
 */
export const authRateLimit = () => rateLimit({ perWindowMs: 60_000, max: 10 });

const userBuckets = new Map<string, Bucket>();

/**
 * Test hook — drops every in-memory rate-limit bucket. Production code never
 * calls this; it exists so handler unit tests can run many sequential
 * requests against the same IP without tripping the 10/min auth limit.
 */
export function __resetRateLimitForTests(): void {
  buckets.clear();
  userBuckets.clear();
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
 * In-memory + per-container, same caveat as `rateLimit`. For a global
 * limit swap the Map for a DDB conditional update.
 */
export function userRateLimit(
  opts: { perWindowMs: number; max: number } = { perWindowMs: 60_000, max: 60 }
): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = (request) => {
    const userId = (request.event as AuthenticatedEvent).user?.userId;
    if (!userId) return;
    const key = `${request.event.path}|${userId}`;
    const now = Date.now();
    const existing = userBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
      userBuckets.set(key, { count: 1, resetAt: now + opts.perWindowMs });
      return;
    }
    if (existing.count >= opts.max) {
      audit('rate_limit.tripped', { metadata: { key } });
      throw createHttpError(429, 'Too many requests. Please slow down and try again.');
    }
    existing.count += 1;
  };
  return { before };
}
