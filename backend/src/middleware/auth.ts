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
import {
  getCachedMembership,
  setCachedMembership,
  __resetMembershipCacheForTests as __resetCache,
} from '../utils/membershipCache.js';

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
  /**
   * True when the principal is an API key (`apiKeyMiddleware`), not a human
   * Cognito user. Write routes should structurally reject key principals by
   * checking this flag rather than relying on `householdRole`, which is kept
   * at `'member'` for backward compatibility with read-path gates.
   */
  isApiKey?: boolean;
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
 *
 * Every household context — whether it comes from the `X-Household-Id`
 * override header or from the JWT's `custom:household_id` claim — is
 * validated against the membership table before being attached to
 * `event.user`. The `custom:household_*` claims are defense-in-depth only
 * and are NEVER trusted on their own: the membership row is authoritative
 * for both membership and role, so a stale or tampered claim can't grant
 * access (and a removed member loses access well before the ~1h token
 * lifetime would expire the claim).
 *
 * Lookups go through a small per-warm-container cache
 * (utils/membershipCache.ts, 60s TTL — roughly one DDB read per user per
 * minute per container). Mutations that change membership (setMemberRole,
 * removeMember) invalidate the cache synchronously, but only in the
 * container that processed the mutation: other warm containers keep their
 * cached entry until the TTL lapses. The honest staleness bound is
 * therefore ≤60s cross-container, not "the very next request".
 */
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

    // Identity from Cognito claims; household context is resolved below.
    const user: AuthenticatedUser = {
      userId: claims.sub,
      email: claims.email,
      householdId: null,
      householdRole: null,
    };

    // Multi-household support via `X-Household-Id`. The middleware MUST
    // validate that the JWT subject is actually a member of the requested
    // household before honoring the override — otherwise an attacker can
    // read any other household's data by just setting the header. Resource
    // handlers can't be relied on for this check: most of them compare
    // `user.householdId` to a path param, which is `headerValue ===
    // pathValue` after the override.
    //
    // The claim-derived default household goes through the SAME validation.
    // The `custom:household_*` claims are user-influenced attributes (and
    // even once locked down at the pool level they lag membership changes
    // by the token lifetime), so the claim is only a *hint* for which
    // household to resolve — the membership row decides membership AND
    // role. A user who was removed from their household gets a 403 within
    // the 60s cache TTL instead of keeping access until token expiry.
    const headerOverride = event.headers?.['x-household-id'] ?? event.headers?.['X-Household-Id'];
    const claimHouseholdId = claims['custom:household_id'] || null;
    const requestedHouseholdId =
      typeof headerOverride === 'string' && headerOverride.length > 0
        ? headerOverride
        : claimHouseholdId;

    if (requestedHouseholdId) {
      let role = getCachedMembership(claims.sub, requestedHouseholdId);
      if (!role) {
        const member = await getMemberByUserId(requestedHouseholdId, claims.sub);
        if (!member) {
          throw createHttpError(403, 'Not a member of the requested household');
        }
        role = member.role;
        setCachedMembership(claims.sub, requestedHouseholdId, role);
      }
      user.householdId = requestedHouseholdId;
      // Membership row is authoritative — never the claim's role.
      user.householdRole = role;
    }

    (event as AuthenticatedEvent).user = user;
  };

  return { before };
};

// Exposed for tests that need to force a re-check.
export const __resetMembershipCacheForTests = __resetCache;

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

/**
 * Structurally reject machine (API-key) principals with a 403, regardless of
 * scope or role. API keys carry `householdRole: 'member'` for read-path
 * compatibility, so a role check can't tell them apart from a human — the
 * authoritative signal is `user.isApiKey` (set by apiKeyMiddleware).
 *
 * Use this as defense-in-depth on internal/operational routes that should
 * only ever be reached by a human admin or an internal IAM-signed invocation
 * — the reminder/digest/recap cron triggers — so a leaked key can never fan
 * out paid notification sends even if it somehow reached the route. This also
 * gives the otherwise-unused `isApiKey` flag a real enforcement use.
 */
export const rejectApiKeyPrincipal = (): middy.MiddlewareObj<
  AuthenticatedEvent,
  APIGatewayProxyResult
> => {
  const before: middy.MiddlewareFn<AuthenticatedEvent, APIGatewayProxyResult> = (request) => {
    if (request.event.user?.isApiKey) {
      throw createHttpError(403, 'API keys cannot access this route');
    }
  };

  return { before };
};
