/**
 * API-key authentication middleware for `/api/v1/*` routes. Different from
 * `authMiddleware`:
 *
 *   - Reads `Authorization: Bearer fg_...` (or the alternate `X-Api-Key`
 *     header) instead of Cognito JWT claims.
 *   - Looks up the key in DDB (one point read via GSI3).
 *   - Attaches an `event.user` shape compatible with downstream `requireHousehold`
 *     so existing handler code can be reused.
 *
 * The shape compatibility means we don't have to fork every read service —
 * the public API can call into the same `plantService.getPlants(householdId)`
 * the JWT'd handlers use.
 */
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import * as apiKeys from '../services/apiKeys.js';
import type { ApiScope } from '../services/apiKeys.js';
import * as billing from '../services/billing.js';
import { getPlan } from '../models/plans.js';
import type { AuthenticatedEvent } from './auth.js';

/** Event shape after `apiKeyMiddleware` runs — carries the key's scopes. */
export interface ApiKeyEvent extends AuthenticatedEvent {
  apiScopes: ApiScope[];
  /**
   * Identity of the key itself, for attribution on write routes (activity
   * rows, audit logs). `createdBy` is the Cognito user id of the admin who
   * issued the key.
   */
  apiKey: { id: string; label: string; createdBy: string };
}

export const apiKeyMiddleware = (): middy.MiddlewareObj<
  APIGatewayProxyEvent,
  APIGatewayProxyResult
> => {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = async (
    request
  ) => {
    const event = request.event;
    const auth = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
    const altHeader = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'];
    let plaintext: string | undefined;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      plaintext = auth.slice(7).trim();
    } else if (typeof altHeader === 'string') {
      plaintext = altHeader.trim();
    }

    if (!plaintext) {
      throw createHttpError(401, 'API key required');
    }

    const record = await apiKeys.lookupApiKey(plaintext);
    if (!record) {
      throw createHttpError(401, 'Invalid API key');
    }

    // API access is a Greenhouse-plan feature, but the key row itself has no
    // notion of the household's CURRENT plan — only that it was valid to
    // mint. Re-check on every use so a downgrade revokes access immediately
    // instead of leaving already-issued keys live forever.
    const sub = await billing.getHouseholdSubscription(record.householdId);
    if (getPlan(sub.planId).id !== 'greenhouse') {
      throw createHttpError(
        403,
        'API access requires the Greenhouse plan. This household has downgraded — upgrade to keep using this key.'
      );
    }

    // Attach a minimal user shape. We deliberately don't synthesize an email
    // (no associated Cognito user); routes that need email should refuse
    // here. For the read-only public API surface, householdId is enough.
    //
    // `isApiKey: true` marks this principal as a machine key so write routes
    // can structurally reject it. `householdRole: 'member'` is kept only for
    // backward compatibility with read-path gates (`requireHousehold` etc.) —
    // do NOT use the role to distinguish keys from humans.
    (event as AuthenticatedEvent).user = {
      userId: `apikey:${record.id}`,
      email: '',
      householdId: record.householdId,
      householdRole: 'member',
      isApiKey: true,
    };
    (event as ApiKeyEvent).apiScopes = record.scopes;
    (event as ApiKeyEvent).apiKey = {
      id: record.id,
      label: record.label,
      createdBy: record.createdBy,
    };
  };

  return { before };
};

/**
 * Gate a public-API route on a specific scope. Stack it after
 * `apiKeyMiddleware` (which populates `event.apiScopes`). A key missing the
 * scope gets a 403 naming what it needs, so an integrator knows to re-issue a
 * broader key rather than guessing.
 */
export const requireApiScope = (
  scope: ApiScope
): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> => {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = (request) => {
    const scopes = (request.event as ApiKeyEvent).apiScopes ?? [];
    if (!scopes.includes(scope)) {
      throw createHttpError(403, `This API key is missing the required scope: ${scope}`);
    }
  };

  return { before };
};
