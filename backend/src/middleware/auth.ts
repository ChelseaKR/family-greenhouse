/**
 * Authentication + authorization middleware for the Lambda handlers.
 *
 * The Cognito user-pool authorizer attached to API Gateway pre-validates the
 * JWT and forwards the decoded claims as `event.requestContext.authorizer.claims`.
 * `authMiddleware` reads those claims and projects them onto a typed
 * `event.user` object so downstream code never has to touch raw claims.
 *
 * `requireHousehold` and `requireAdmin` are simple gates that 403 when the
 * caller doesn't satisfy them. Stack them after `authMiddleware`.
 */
import middy from '@middy/core';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { getMemberByUserId } from '../services/householdService.js';

/**
 * The shape we attach to every authenticated event. `householdId` and
 * `householdRole` are nullable because users in onboarding are authenticated
 * but haven't joined a household yet.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  householdId: string | null;
  householdRole: 'admin' | 'member' | null;
}

export interface AuthenticatedEvent extends APIGatewayProxyEvent {
  user: AuthenticatedUser;
}

/**
 * The subset of Cognito JWT claims we read. The API Gateway authorizer types
 * `claims` as `any`; narrowing it here keeps the rest of the middleware
 * type-safe.
 */
interface CognitoClaims {
  sub: string;
  email: string;
  'custom:household_id'?: string;
  'custom:household_role'?: 'admin' | 'member';
}

/**
 * Project Cognito claims onto `event.user`. Throws 401 when the request was
 * never authenticated — usually means the route is missing the Cognito
 * authorizer in API Gateway, not a runtime issue.
 */
// In-warm-container membership cache. Keyed by `<userId>#<householdId>`,
// holds the resolved role for a few minutes. Eliminates the per-request
// DDB GetItem for repeat requests from the same client without crossing
// the trust boundary.
const MEMBERSHIP_CACHE_TTL_MS = 60_000;
const membershipCache = new Map<string, { role: 'admin' | 'member'; expiresAt: number }>();

export const authMiddleware = (): middy.MiddlewareObj<
  APIGatewayProxyEvent,
  APIGatewayProxyResult
> => {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = async (
    request
  ) => {
    const event = request.event;
    // API Gateway puts the verified claims in different places depending on
    // the API type: REST/HTTP-v1 authorizer → `authorizer.claims`; HTTP API
    // v2 JWT authorizer → `authorizer.jwt.claims`. Read whichever is present
    // so the same handler works behind either.
    const authorizer = event.requestContext?.authorizer as
      | { claims?: CognitoClaims; jwt?: { claims?: CognitoClaims } }
      | undefined;
    const claims = authorizer?.jwt?.claims ?? authorizer?.claims;

    if (!claims) {
      throw createHttpError(401, 'Unauthorized');
    }

    // Default identity from Cognito claims.
    const user: AuthenticatedUser = {
      userId: claims.sub,
      email: claims.email,
      householdId: claims['custom:household_id'] || null,
      householdRole: claims['custom:household_role'] || null,
    };

    // Multi-household support via `X-Household-Id`. The middleware MUST
    // validate that the JWT subject is actually a member of the requested
    // household before honoring the override — otherwise an attacker can
    // read any other household's data by just setting the header. Resource
    // handlers can't be relied on for this check: most of them compare
    // `user.householdId` to a path param, which is `headerValue ===
    // pathValue` after the override.
    const headerOverride = event.headers?.['x-household-id'] ?? event.headers?.['X-Household-Id'];
    if (typeof headerOverride === 'string' && headerOverride.length > 0) {
      // Cheap pre-check: the override IS the user's default household.
      // No DDB lookup needed (the claim already proves membership).
      if (headerOverride === user.householdId) {
        // role stays as the claim-derived one
      } else {
        const cacheKey = `${claims.sub}#${headerOverride}`;
        const cached = membershipCache.get(cacheKey);
        let role: 'admin' | 'member' | undefined;
        if (cached && cached.expiresAt > Date.now()) {
          role = cached.role;
        } else {
          const member = await getMemberByUserId(headerOverride, claims.sub);
          if (!member) {
            throw createHttpError(403, 'Not a member of the requested household');
          }
          role = member.role;
          membershipCache.set(cacheKey, {
            role,
            expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL_MS,
          });
        }
        user.householdId = headerOverride;
        user.householdRole = role;
      }
    }

    (event as AuthenticatedEvent).user = user;
  };

  return { before };
};

// Exposed for tests that need to force a re-check.
export function __resetMembershipCacheForTests(): void {
  membershipCache.clear();
}

/**
 * 403 if the caller hasn't joined or created a household. Most resource
 * routes need this — plants/tasks/etc. all live under a household partition.
 */
export const requireHousehold = (): middy.MiddlewareObj<
  AuthenticatedEvent,
  APIGatewayProxyResult
> => {
  const before: middy.MiddlewareFn<AuthenticatedEvent, APIGatewayProxyResult> = (request) => {
    if (!request.event.user?.householdId) {
      throw createHttpError(403, 'User must belong to a household');
    }
  };

  return { before };
};

/**
 * 403 unless `householdRole === 'admin'`. Stack after `requireHousehold` —
 * this middleware doesn't double-check that a household exists, it just
 * checks the role.
 */
export const requireAdmin = (): middy.MiddlewareObj<AuthenticatedEvent, APIGatewayProxyResult> => {
  const before: middy.MiddlewareFn<AuthenticatedEvent, APIGatewayProxyResult> = (request) => {
    if (request.event.user?.householdRole !== 'admin') {
      throw createHttpError(403, 'Admin access required');
    }
  };

  return { before };
};
