/**
 * Public API v1. Read-only endpoints scoped to the household that owns the
 * API key. Reuses existing service functions so behavior matches the
 * authenticated UI; only the auth layer differs.
 *
 * Versioning: the path prefix `/api/v1` is the contract. New incompatible
 * changes go behind `/api/v2`. Backwards-compatible additions land in v1.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { apiKeyMiddleware, requireApiScope } from '../../middleware/apiKey.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import type { AuthenticatedEvent } from '../../middleware/auth.js';
import * as plantService from '../../services/plantService.js';
import * as taskService from '../../services/taskService.js';
import { dynamodb, TABLE_NAME } from '../../utils/dynamodb.js';
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

// GET /health
// Unauthenticated liveness probe: proves the Lambda boots, the router
// dispatches end-to-end, and the data plane is reachable. Returns the build
// SHA so a synthetic monitor can also catch a stuck/old deploy, not just a
// hard outage. No auth and no rate limit — it must stay cheap and always
// reachable for uptime checks (the prod smoke test previously had to use
// /billing/plans because no health route existed).
//
// Shape matches the local-server mock + the /status page contract:
//   { status, version, checkedAt, components: { database, auth, mail } }
// `database` is a real reachability probe (a cheap GetItem on a sentinel
// key). `auth`/`mail` are reported passively for now — they're not actively
// probed, so they stay 'ok' until a dedicated check is added.
export const health = createHandler(async (): Promise<APIGatewayProxyResult> => {
  let database: 'ok' | 'error' = 'ok';
  try {
    await dynamodb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: 'HEALTHCHECK', SK: 'PROBE' },
      })
    );
  } catch {
    database = 'error';
  }

  const overall = database === 'ok' ? 'ok' : 'degraded';
  return successResponse({
    status: overall,
    version: process.env.GIT_SHA ?? 'unknown',
    checkedAt: new Date().toISOString(),
    components: {
      database: { status: database },
      auth: { status: 'ok' },
      mail: { status: 'ok' },
    },
  });
});

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /health': health,
  'GET /api/v1/me': me,
  'GET /api/v1/plants': listPlants,
  'GET /api/v1/plants/{id}': getPlant,
  'GET /api/v1/tasks': listTasks,
  'GET /api/v1/activity': listActivity,
});
