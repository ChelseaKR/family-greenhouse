/**
 * Public API v1. Read-only endpoints scoped to the household that owns the
 * API key. Reuses existing service functions so behavior matches the
 * authenticated UI; only the auth layer differs.
 *
 * Versioning: the path prefix `/api/v1` is the contract. New incompatible
 * changes go behind `/api/v2`. Backwards-compatible additions land in v1.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { apiKeyMiddleware, requireApiScope } from '../../middleware/apiKey.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import type { AuthenticatedEvent } from '../../middleware/auth.js';
import * as plantService from '../../services/plantService.js';
import * as taskService from '../../services/taskService.js';
import { successResponse } from '../../utils/response.js';

// Two-layer rate limit on the public API:
//
//   1. `apiRateLimit` (per-IP) is the outer envelope — catches anonymous
//      flood traffic before we even authenticate the key.
//   2. `perKeyRateLimit` (per-key) runs after `apiKeyMiddleware`, which
//      sets `event.user.userId = "apikey:<id>"`. The same `userRateLimit`
//      we use on JWT routes naturally keys on that synthetic id, so each
//      API key gets its own per-route bucket.
//
// Defaults are tunable when we have real usage signal.
const apiRateLimit = () => rateLimit({ perWindowMs: 60_000, max: 120 });
const perKeyRateLimit = () => userRateLimit({ perWindowMs: 60_000, max: 60 });

// GET /api/v1/me
// Returns the household this API key is scoped to.
export const me = createHandler((event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { user } = event as AuthenticatedEvent;
  return Promise.resolve(
    successResponse({
      householdId: user.householdId,
      apiVersion: 'v1',
    })
  );
})
  .use(apiRateLimit())
  .use(apiKeyMiddleware())
  .use(perKeyRateLimit());

// GET /api/v1/plants
export const listPlants = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plants = await plantService.getPlants(user.householdId!);
    return successResponse(plants);
  }
)
  .use(apiRateLimit())
  .use(apiKeyMiddleware())
  .use(perKeyRateLimit())
  .use(requireApiScope('read:plants'));

// GET /api/v1/plants/:id
export const getPlant = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.id;
    if (!plantId) throw createHttpError(400, 'Plant ID is required');
    const plant = await plantService.getPlant(user.householdId!, plantId);
    if (!plant) throw createHttpError(404, 'Plant not found');
    return successResponse(plant);
  }
)
  .use(apiRateLimit())
  .use(apiKeyMiddleware())
  .use(perKeyRateLimit())
  .use(requireApiScope('read:plants'));

// GET /api/v1/tasks
export const listTasks = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const tasks = await taskService.getTasks(user.householdId!);
    return successResponse(tasks);
  }
)
  .use(apiRateLimit())
  .use(apiKeyMiddleware())
  .use(perKeyRateLimit())
  .use(requireApiScope('read:tasks'));

// GET /api/v1/activity
export const listActivity = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const limitRaw = event.queryStringParameters?.limit;
    const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50)) : 50;
    const items = await taskService.getHouseholdActivity(user.householdId!, limit);
    return successResponse(items);
  }
)
  .use(apiRateLimit())
  .use(apiKeyMiddleware())
  .use(perKeyRateLimit())
  .use(requireApiScope('read:activity'));

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /api/v1/me': me,
  'GET /api/v1/plants': listPlants,
  'GET /api/v1/plants/{id}': getPlant,
  'GET /api/v1/tasks': listTasks,
  'GET /api/v1/activity': listActivity,
});
