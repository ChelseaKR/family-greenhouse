/**
 * Authenticated (Cognito) endpoints for users to manage their API keys.
 * Plan-gated to Greenhouse — Garden + Seedling households see a "upgrade
 * to use the API" message in the UI rather than a 403 here.
 *
 * The plaintext key is returned ONLY from the create endpoint. Everywhere
 * else we return `last4` for visual identification.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  requireAdmin,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import * as apiKeysService from '../../services/apiKeys.js';
import * as billing from '../../services/billing.js';
import { audit } from '../../utils/auditLog.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';

const createSchema = z.object({
  label: z.string().min(1).max(60),
  // Optional least-privilege scopes. Omitted/empty → full read access (the
  // simple "just give me a key" path). Unknown scopes are rejected by the enum.
  scopes: z.array(z.enum(apiKeysService.API_SCOPES)).optional(),
});
type CreateInput = z.infer<typeof createSchema>;

async function requireGreenhousePlan(householdId: string) {
  const sub = await billing.getHouseholdSubscription(householdId);
  if (sub.planId !== 'greenhouse') {
    throw createHttpError(
      402,
      'API access is included with the Greenhouse plan. Upgrade to issue API keys.'
    );
  }
}

// GET /api-keys
export const listKeys = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const keys = await apiKeysService.listApiKeys(user.householdId!);
    return successResponse(keys);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /api-keys
export const createKey = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CreateInput>;
    await requireGreenhousePlan(user.householdId!);
    const result = await apiKeysService.createApiKey(
      user.householdId!,
      user.userId,
      validatedBody.label,
      validatedBody.scopes
    );
    audit('apikey.created', {
      actorId: user.userId,
      householdId: user.householdId ?? undefined,
      metadata: { keyId: result.record.id, label: result.record.label },
    });
    return createdResponse(result);
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(createSchema));

// DELETE /api-keys/:id
export const revokeKey = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const keyId = event.pathParameters?.id;
    if (!keyId) throw createHttpError(400, 'Key ID is required');
    const deleted = await apiKeysService.revokeApiKey(user.householdId!, keyId);
    if (!deleted) {
      // 404 per convention — a 204 for an id that never existed hides typos
      // and makes "did I actually revoke it?" unanswerable for callers.
      throw createHttpError(404, 'API key not found');
    }
    audit('apikey.revoked', {
      actorId: user.userId,
      householdId: user.householdId ?? undefined,
      metadata: { keyId },
    });
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /api-keys': listKeys,
  'POST /api-keys': createKey,
  'DELETE /api-keys/{id}': revokeKey,
});
