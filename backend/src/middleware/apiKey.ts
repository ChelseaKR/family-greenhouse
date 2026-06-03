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
import type { AuthenticatedEvent } from './auth.js';

/** Event shape after `apiKeyMiddleware` runs — carries the key's scopes. */
export interface ApiKeyEvent extends AuthenticatedEvent {
  apiScopes: ApiScope[];
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

    // Attach a minimal user shape. We deliberately don't synthesize an email
    // (no associated Cognito user); routes that need email should refuse
    // here. For the read-only public API surface, householdId is enough.
    (event as AuthenticatedEvent).user = {
      userId: `apikey:${record.id}`,
      email: '',
      householdId: record.householdId,
      householdRole: 'member',
    };
    (event as ApiKeyEvent).apiScopes = record.scopes;
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
