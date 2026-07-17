/**
 * Public API v1. Endpoints scoped to the household that owns the API key —
 * read routes plus two task-write routes gated on the explicit `write:tasks`
 * scope. Reuses existing service functions so behavior matches the
 * authenticated UI; only the auth layer differs.
 *
 * Versioning: the path prefix `/api/v1` is the contract. New incompatible
 * changes go behind `/api/v2`. Backwards-compatible additions land in v1.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware } from '../../middleware/auth.js';
import { apiKeyMiddleware, requireApiScope, type ApiKeyEvent } from '../../middleware/apiKey.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import { validateBody, type ValidatedEvent } from '../../middleware/validation.js';
import type { AuthenticatedEvent } from '../../middleware/auth.js';
import type { LoggedEvent } from '../../middleware/logging.js';
import * as plantService from '../../services/plantService.js';
import * as taskService from '../../services/taskService.js';
import { recordActivity } from '../../services/activity.js';
import { audit } from '../../utils/auditLog.js';
import { dynamodb, TABLE_NAME } from '../../utils/dynamodb.js';
import { noContentResponse, successResponse } from '../../utils/response.js';
import {
  frontendTelemetrySchema,
  productTelemetrySchema,
  type FrontendTelemetryInput,
  type ProductTelemetryInput,
} from '../../models/telemetry.js';

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

// OPTIONS /{proxy+}
// Catch-all unauthenticated preflight route. Middy's CORS `before` hook
// short-circuits this handler with a 204 and the exact matching origin; the
// body below is only a defensive fallback if middleware behavior changes.
export const preflight = createHandler((): Promise<APIGatewayProxyResult> =>
  Promise.resolve({
    statusCode: 204,
    headers: {},
    body: '',
  })
);

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

// ---------------------------------------------------------------------------
// Write routes (scope: write:tasks)
//
// API-key principals act AS THE HOUSEHOLD, not as a human user: mutations are
// attributed to the synthetic actor `apikey:{keyId}` (the same id the rate
// limiter buckets on) with the key's label as the display name, so the
// activity feed shows which integration acted. taskService is consumed via
// its exported functions only — same call shape as the app's task handlers.
// ---------------------------------------------------------------------------

// Bodies are optional on both write routes (a bare POST is the common
// integration case), so the schemas accept a null/absent body. Handlers read
// fields with `?.` instead of relying on a transform, keeping the schemas'
// input and output types identical (what `validateBody`'s generic expects).
const apiCompleteTaskSchema = z.object({ notes: z.string().max(500).optional() }).nullish();
type ApiCompleteTaskInput = z.infer<typeof apiCompleteTaskSchema>;

const apiSnoozeTaskSchema = z
  .object({ days: z.number().int().min(1).max(365).optional() })
  .nullish();
type ApiSnoozeTaskInput = z.infer<typeof apiSnoozeTaskSchema>;

// POST /api/v1/tasks/{id}/complete
export const completeTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user, apiKey } = event as ApiKeyEvent;
    const { validatedBody } = event as ValidatedEvent<ApiCompleteTaskInput>;
    const taskId = event.pathParameters?.id;
    if (!taskId) throw createHttpError(400, 'Task ID is required');

    const task = await taskService.completeTask(
      user.householdId!,
      taskId,
      user.userId, // "apikey:{keyId}" — explicit machine actor
      apiKey?.label ?? 'API',
      validatedBody?.notes
    );
    if (!task) throw createHttpError(404, 'Task not found');

    audit('api.task_completed', {
      actorId: user.userId,
      householdId: user.householdId ?? undefined,
      metadata: { taskId, keyId: apiKey?.id },
    });
    return successResponse(task);
  }
)
  .use(apiRateLimit())
  .use(apiKeyMiddleware())
  .use(perKeyRateLimit())
  .use(requireApiScope('write:tasks'))
  .use(validateBody(apiCompleteTaskSchema));

// POST /api/v1/tasks/{id}/snooze
// body: { days? } — omitted days defaults to the task's own frequency, i.e.
// "skip one cycle", matching what the app's skip suggestions do.
export const snoozeTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user, apiKey } = event as ApiKeyEvent;
    const { validatedBody } = event as ValidatedEvent<ApiSnoozeTaskInput>;
    const taskId = event.pathParameters?.id;
    if (!taskId) throw createHttpError(400, 'Task ID is required');

    const existing = await taskService.getTask(user.householdId!, taskId);
    if (!existing) throw createHttpError(404, 'Task not found');
    const days = validatedBody?.days ?? existing.frequency;

    const task = await taskService.snoozeTask(user.householdId!, taskId, days);
    if (!task) throw createHttpError(404, 'Task not found');

    // Same activity-feed entry the app's snooze writes (recordActivity
    // logs-and-continues on failure, so this can't fail the request).
    await recordActivity({
      type: 'task.snoozed',
      householdId: user.householdId!,
      actorId: user.userId,
      actorName: apiKey?.label ?? 'API',
      payload: {
        taskId,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        days,
        reason: null,
        note: null,
      },
    });

    audit('api.task_snoozed', {
      actorId: user.userId,
      householdId: user.householdId ?? undefined,
      metadata: { taskId, keyId: apiKey?.id, days },
    });
    return successResponse(task);
  }
)
  .use(apiRateLimit())
  .use(apiKeyMiddleware())
  .use(perKeyRateLimit())
  .use(requireApiScope('write:tasks'))
  .use(validateBody(apiSnoozeTaskSchema));

// POST /telemetry/frontend
// Public because browser failures can happen before authentication. Payloads
// are small, strictly typed, stripped of stack traces and user identifiers,
// and IP-rate-limited before they are written to structured CloudWatch logs.
export const frontendTelemetry = createHandler(
  (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<FrontendTelemetryInput>;
    const log = (event as LoggedEvent).log;
    log.info({ ...validatedBody, msg: 'frontend_telemetry' }, 'frontend_telemetry');
    return Promise.resolve(noContentResponse());
  },
  { maxBodyBytes: 4096 }
)
  .use(rateLimit({ perWindowMs: 60_000, max: 60 }))
  .use(validateBody(frontendTelemetrySchema));

// POST /telemetry/product
// Authentication supplies actor/household identity; the browser body cannot
// forge either. Only enumerated funnel events and discriminator properties
// are accepted, so plant names, emails, addresses, and other free text never
// enter the analytics log stream.
export const productTelemetry = createHandler(
  (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<ProductTelemetryInput>;
    const { user } = event as AuthenticatedEvent;
    const log = (event as LoggedEvent).log;
    log.info(
      {
        msg: 'product_event',
        productEvent: validatedBody.event,
        properties: validatedBody.properties,
        superProperties: validatedBody.superProperties,
        actorId: user.userId,
        householdId: user.householdId ?? undefined,
      },
      'product_event'
    );
    return Promise.resolve(noContentResponse());
  },
  { maxBodyBytes: 4096 }
)
  .use(authMiddleware())
  .use(userRateLimit({ perWindowMs: 60_000, max: 120 }))
  .use(validateBody(productTelemetrySchema));

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
  'OPTIONS /{proxy+}': preflight,
  'POST /telemetry/frontend': frontendTelemetry,
  'POST /telemetry/product': productTelemetry,
  'GET /health': health,
  'GET /api/v1/me': me,
  'GET /api/v1/plants': listPlants,
  'GET /api/v1/plants/{id}': getPlant,
  'GET /api/v1/tasks': listTasks,
  'GET /api/v1/activity': listActivity,
  'POST /api/v1/tasks/{id}/complete': completeTask,
  'POST /api/v1/tasks/{id}/snooze': snoozeTask,
});
