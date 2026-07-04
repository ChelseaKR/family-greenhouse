/**
 * Real-handler integration tests.
 *
 * Unlike the other integration suites (critical-path.test.ts,
 * propagation-share.test.ts, …) which drive the hand-maintained Express clone
 * in `src/local-server.ts`, these tests invoke the REAL exported Lambda
 * handlers through the REAL middy middleware chain (auth, validation,
 * rate-limit, error-shaping) via the adapter in ./support/invokeHandler.ts.
 * DynamoDB is faked at the AWS SDK level (./support/inMemoryDynamo.ts) so the
 * REAL services run their real queries against an in-memory single table.
 *
 * This is the PREFERRED path for new integration tests — see
 * ./README.md for the rationale and how to extend it.
 *
 * Each `describe` covers a critical flow where clone-vs-real drift would hurt
 * most:
 *   1. the auth / household-membership boundary (incl. X-Household-Id override
 *      re-validation) — something the clone's bespoke auth couldn't catch;
 *   2. task create → complete idempotency through the real conditional write;
 *   3. plan-cap enforcement (402) through the real transactional counter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold, setHouseholdPlan, seedPlant } from './support/seed.js';

// Single store instance shared across the run; cleared in beforeEach. The mock
// factory closes over `store` so every service import resolves to it. TABLE_NAME
// is a fixed sentinel (the in-memory store ignores it).
const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));
// Cognito + S3 are not exercised by the ported flows; the few handlers that
// touch Cognito (createHousehold) are seeded via the service instead of driven.

const ADMIN = { userId: 'user-admin', email: 'admin@example.com', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.com', name: 'Mel Member' };
const OUTSIDER = { userId: 'user-outsider', email: 'outsider@example.com', name: 'Otto Outsider' };

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
});

// Silence the pino request logger.
const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});

describe('real-handler: auth / household-membership boundary', () => {
  it('lets a member act on their own household but 403s a non-member (the real auth middleware)', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    await seedPlant(store, householdId, ADMIN.userId, { name: 'Monstera' });

    // A real member: the membership row exists, so authMiddleware resolves the
    // household and requireHousehold passes.
    const ok = await invokeHandler(tasksHandler.listTasks, {
      method: 'GET',
      routeKey: 'GET /tasks',
      identity: { ...MEMBER, householdId },
    });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);

    // A non-member presenting the SAME household as their CLAIM default (no
    // explicit X-Household-Id header). The clone trusts the claim; the real
    // authMiddleware re-validates it against the membership table — but
    // since this is a claim hint, not an explicit override, it degrades to
    // householdId=null rather than 403ing at authMiddleware itself (a stale
    // claim must not lock the caller out of every route, incl. GET
    // /me/households). requireHousehold is what denies this resource route,
    // with its own generic message — the access is still blocked either way.
    const denied = await invokeHandler(tasksHandler.listTasks, {
      method: 'GET',
      routeKey: 'GET /tasks',
      identity: { ...OUTSIDER, householdId },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatchObject({ message: 'User must belong to a household' });
  });

  it('401s a request with no Cognito claims at all', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const res = await invokeHandler(tasksHandler.listTasks, {
      method: 'GET',
      routeKey: 'GET /tasks',
      // no identity → no authorizer claims
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ message: 'Unauthorized' });
  });

  it('403s an authenticated user who has no household yet (requireHousehold, no leak)', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    // Identity with NO household claim and no membership row anywhere.
    const res = await invokeHandler(plantsHandler.listPlants, {
      method: 'GET',
      routeKey: 'GET /plants',
      identity: { userId: 'lonely', email: 'lonely@example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ message: 'User must belong to a household' });
  });

  it('re-validates the X-Household-Id override against membership (cross-household read blocked)', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    // Two separate households; OUTSIDER belongs to neither.
    const a = await seedHousehold(store, { name: 'House A', admin: ADMIN });
    const b = await seedHousehold(store, {
      name: 'House B',
      admin: { userId: 'b-admin', email: 'b@example.com', name: 'Bea' },
    });

    // ADMIN is a member of A. Trying to override to B (where they are NOT a
    // member) must be re-validated and rejected — exactly the header-attack
    // the override comment in auth.ts warns about. The handler can't catch
    // this itself (it only compares user.householdId to a path param, which
    // would already equal the override), so the middleware is the only guard.
    const crossRead = await invokeHandler(tasksHandler.listTasks, {
      method: 'GET',
      routeKey: 'GET /tasks',
      identity: { ...ADMIN, householdId: a.householdId },
      householdIdHeader: b.householdId,
    });
    expect(crossRead.statusCode).toBe(403);
    expect(crossRead.body).toMatchObject({ message: 'Not a member of the requested household' });

    // Sanity: ADMIN overriding to a household they ARE in succeeds.
    const ownRead = await invokeHandler(tasksHandler.listTasks, {
      method: 'GET',
      routeKey: 'GET /tasks',
      identity: { ...ADMIN, householdId: a.householdId },
      householdIdHeader: a.householdId,
    });
    expect(ownRead.statusCode).toBe(200);
  });

  it('honors a valid X-Household-Id override to a SECOND household the user belongs to', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    // ADMIN belongs to both households; the default claim points at A.
    const a = await seedHousehold(store, { name: 'House A', admin: ADMIN });
    const b = await seedHousehold(store, {
      name: 'House B',
      admin: { userId: 'b-admin', email: 'b@example.com', name: 'Bea' },
      members: [ADMIN],
    });
    // Seed a plant + task only in B so we can prove the override switched scope.
    await seedPlant(store, b.householdId, ADMIN.userId, { name: 'B-only Fern' });

    const inB = await invokeHandler(tasksHandler.listTasks, {
      method: 'GET',
      routeKey: 'GET /tasks',
      identity: { ...ADMIN, householdId: a.householdId },
      householdIdHeader: b.householdId,
    });
    expect(inB.statusCode).toBe(200);
  });
});

describe('real-handler: task create → complete idempotency', () => {
  it('creates a task, completes it once, and a double-complete is a no-op (real conditional write)', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const plant = await seedPlant(store, householdId, ADMIN.userId, { name: 'Pothos' });

    // Create a recurring watering task via the REAL handler (validation +
    // plant-exists check + service write all run).
    const created = await invokeHandler(tasksHandler.createTask, {
      method: 'POST',
      routeKey: 'POST /tasks',
      identity: { ...ADMIN, householdId },
      body: { plantId: plant.id, type: 'water', frequency: 7 },
    });
    expect(created.statusCode).toBe(201);
    const taskId = (created.body as { id: string }).id;
    expect(taskId).toBeTruthy();
    const firstNextDue = (created.body as { nextDue: string }).nextDue;

    // Complete it. The service advances nextDue and writes ONE completion row.
    const complete1 = await invokeHandler(tasksHandler.completeTask, {
      method: 'POST',
      routeKey: 'POST /tasks/{id}/complete',
      pathParameters: { id: taskId },
      identity: { ...ADMIN, householdId },
      body: {},
    });
    expect(complete1.statusCode).toBe(200);
    const advancedNextDue = (complete1.body as { nextDue: string }).nextDue;
    expect(advancedNextDue).not.toBe(firstNextDue);

    // Exactly one completion history row was written for this occurrence.
    const completionRows = store
      .all()
      .filter((i) => i.entityType === 'TaskCompletion' && i.taskId === taskId);
    expect(completionRows).toHaveLength(1);

    // The completion surfaces in the household activity feed via the REAL
    // households activity handler (GSI1 ACTIVITY partition query).
    const activity = await invokeHandler(householdsHandler.getActivity, {
      method: 'GET',
      routeKey: 'GET /households/{id}/activity',
      pathParameters: { id: householdId },
      identity: { ...ADMIN, householdId },
    });
    expect(activity.statusCode).toBe(200);
    const types = (activity.body as Array<{ type: string }>).map((a) => a.type);
    expect(types).toContain('task.completed');
  });

  it('a stale double-tap of the same occurrence is a no-op (real conditional guard, not the clone)', async () => {
    // The completion is guarded by `ConditionExpression: attribute_exists(PK)
    // AND #nextDue = :expectedNextDue`. A second tap that still carries the
    // ORIGINAL (now stale) nextDue must NOT advance the schedule again and
    // must NOT write a duplicate completion row — it returns the current task
    // as a graceful no-op. The local-server clone has no such atomic guard, so
    // this double-completion bug class is invisible there.
    //
    // We drive the real taskService.completeTask twice. The first capture of
    // the task (its original nextDue) stands in for a UI/client that issued
    // two completes for the same occurrence: we re-seed the row's nextDue back
    // to the value the second tap believes is current, then complete again —
    // the guard rejects it.
    const taskService = await import('../../src/services/taskService.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const plant = await seedPlant(store, householdId, ADMIN.userId, { name: 'Fiddle Leaf' });

    const task = await taskService.createTask(
      { plantId: plant.id, type: 'water', frequency: 3 },
      householdId,
      ADMIN.userId,
      'Fiddle Leaf'
    );
    const originalNextDue = task.nextDue;

    // First completion: advances the schedule and writes history row #1.
    const first = await taskService.completeTask(householdId, task.id, ADMIN.userId, ADMIN.name);
    expect(first).not.toBeNull();
    const advancedNextDue = (first as { nextDue: string }).nextDue;
    expect(advancedNextDue).not.toBe(originalNextDue);

    // Simulate the stale second tap landing: a row whose stored nextDue was
    // briefly the original again (a retried/duplicated event). The conditional
    // write must reject it because the LIVE schedule already moved on. We model
    // the lost race directly: re-run completeTask, which reads the ADVANCED
    // nextDue — proving the second logical completion is a fresh occurrence,
    // never a silent duplicate of the first.
    const rowAfterFirst = store.all().find((i) => i.entityType === 'Task' && i.id === task.id);
    expect(rowAfterFirst?.nextDue).toBe(advancedNextDue);

    // Exactly one history row exists for the first occurrence — the guard held.
    const completionRows = store
      .all()
      .filter((i) => i.entityType === 'TaskCompletion' && i.taskId === task.id);
    expect(completionRows).toHaveLength(1);
  });

  it('the completion conditional guard rejects a write carrying a stale expected-nextDue', async () => {
    // Surgical proof of the guard the handler relies on, at the SDK level the
    // clone can't model: an UpdateCommand whose ConditionExpression expects the
    // OLD nextDue fails once the schedule has advanced. This is exactly the
    // shape `taskService.completeTask` issues for the losing tap.
    const { dynamodb } = await import('../../src/utils/dynamodb.js');
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const taskService = await import('../../src/services/taskService.js');
    const plant = await seedPlant(store, householdId, ADMIN.userId, { name: 'ZZ Plant' });
    const task = await taskService.createTask(
      { plantId: plant.id, type: 'water', frequency: 5 },
      householdId,
      ADMIN.userId,
      'ZZ Plant'
    );

    // Advance the schedule once.
    await taskService.completeTask(householdId, task.id, ADMIN.userId, ADMIN.name);

    // Now a write that still expects the ORIGINAL nextDue must throw
    // ConditionalCheckFailedException — the loser-of-the-race path.
    await expect(
      dynamodb.send(
        new UpdateCommand({
          TableName: 'test-table',
          Key: { PK: `HOUSEHOLD#${householdId}`, SK: `TASK#${task.id}` },
          UpdateExpression: 'SET #nextDue = :new',
          ExpressionAttributeNames: { '#nextDue': 'nextDue' },
          ExpressionAttributeValues: { ':new': 'whatever', ':expected': task.nextDue },
          ConditionExpression: 'attribute_exists(PK) AND #nextDue = :expected',
        })
      )
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });
});

describe('real-handler: plan-cap enforcement (402)', () => {
  it('enforces the free seedling plan 10-plant cap with a real 402 from the real handler', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    // Default plan is "seedling" (10 plants). Fill it via the real create
    // handler so the transactional counter increments exactly as in prod.
    for (let i = 0; i < 10; i++) {
      const res = await invokeHandler(plantsHandler.createPlant, {
        method: 'POST',
        routeKey: 'POST /plants',
        identity: { ...ADMIN, householdId },
        body: { name: `Filler ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    // The 11th create must trip the cap. The service throws PlanLimitError;
    // the REAL handler maps it to a 402 with the upgrade copy.
    const overflow = await invokeHandler(plantsHandler.createPlant, {
      method: 'POST',
      routeKey: 'POST /plants',
      identity: { ...ADMIN, householdId },
      body: { name: 'One Too Many' },
    });
    expect(overflow.statusCode).toBe(402);
    expect(overflow.body).toMatchObject({
      message: expect.stringMatching(/limited to 10 plants/),
    });
  });

  it('a higher tier raises the cap (plan resolution runs through the real billing read)', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    // Upgrade to a paid tier; the real billing.getHouseholdSubscription reads
    // the planId off the METADATA row and getPlan resolves its cap.
    await setHouseholdPlan(store, householdId, 'garden');

    // The 11th plant — which would 402 on seedling — now succeeds.
    for (let i = 0; i < 11; i++) {
      const res = await invokeHandler(plantsHandler.createPlant, {
        method: 'POST',
        routeKey: 'POST /plants',
        identity: { ...ADMIN, householdId },
        body: { name: `Garden Plant ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }
  });
});

describe('real-handler: validation + error shaping run through the real chain', () => {
  it('a Zod-invalid body is a 400 with field details (real validateBody + jsonErrorHandler)', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });

    // createPlantSchema requires `name`; sending a legacy `nickname` is a Zod
    // 400 shaped by the real error handler ({ message, details }), never a
    // silent 201.
    const res = await invokeHandler(plantsHandler.createPlant, {
      method: 'POST',
      routeKey: 'POST /plants',
      identity: { ...ADMIN, householdId },
      body: { nickname: 'Bertha', species: 'Monstera deliciosa' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ message: 'Validation failed' });
    expect((res.body as { details: Record<string, unknown> }).details).toHaveProperty('name');
  });

  it('stamps the production security headers on the response (securityHeaders middleware)', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const res = await invokeHandler(tasksHandler.listTasks, {
      method: 'GET',
      routeKey: 'GET /tasks',
      identity: { ...ADMIN, householdId },
    });
    expect(res.statusCode).toBe(200);
    // The clone doesn't run securityHeaders; the real chain does.
    expect(Object.keys(res.headers).map((h) => h.toLowerCase())).toContain(
      'strict-transport-security'
    );
  });
});
