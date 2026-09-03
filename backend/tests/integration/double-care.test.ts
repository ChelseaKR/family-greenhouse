/**
 * Double-care detection + schedule drift through the REAL handlers, the REAL
 * middy chain, and the REAL services against the in-memory single table
 * (see ./README.md). What the unit tests cannot show: the window query's
 * key range actually selects the other member's completion row the service
 * wrote, the confirmed completion actually lands tagged, the analytics count
 * actually reads that tag back, and the drift math runs on real rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold, setHouseholdPlan, seedPlant } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));

const ADA = { userId: 'user-ada', email: 'ada@example.com', name: 'Ada Admin' };
const SAM = { userId: 'user-sam', email: 'sam@example.com', name: 'Sam Member' };

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  console.log = () => {};
});

async function seedGardenWithWateringTask() {
  const tasksHandler = await import('../../src/handlers/tasks/handler.js');
  const { householdId } = await seedHousehold(store, { admin: ADA, members: [SAM] });
  await setHouseholdPlan(store, householdId, 'garden');
  const plant = await seedPlant(store, householdId, ADA.userId, { name: 'Fern' });
  const created = await invokeHandler(tasksHandler.createTask, {
    method: 'POST',
    routeKey: 'POST /tasks',
    identity: { ...ADA, householdId },
    body: { plantId: plant.id, type: 'water', frequency: 7 },
  });
  expect(created.statusCode).toBe(201);
  return { householdId, plantId: plant.id, taskId: (created.body as { id: string }).id };
}

/** A completion row exactly as taskService.completeTask writes it. */
function putCompletion(
  householdId: string,
  plantId: string,
  taskId: string,
  completedAt: string,
  by: { userId: string; name: string },
  id: string
) {
  store.put({
    PK: `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
    SK: `COMPLETION#${completedAt}#${id}`,
    GSI1PK: `HOUSEHOLD#${householdId}#ACTIVITY`,
    GSI1SK: completedAt,
    entityType: 'TaskCompletion',
    id,
    householdId,
    plantId,
    taskId,
    taskType: 'water',
    completedBy: by.userId,
    completedByName: by.name,
    completedAt,
    notes: null,
    duplicateOfCompletionId: null,
  });
}

describe('double-care: two members, one fern, one afternoon', () => {
  it('holds the second member’s completion (409), logs it tagged on confirm, and counts it', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const { householdId, taskId } = await seedGardenWithWateringTask();

    // Ada waters the fern.
    const first = await invokeHandler(tasksHandler.completeTask, {
      method: 'POST',
      routeKey: 'POST /tasks/{id}/complete',
      pathParameters: { id: taskId },
      identity: { ...ADA, householdId },
      body: {},
    });
    expect(first.statusCode).toBe(200);
    const adaRow = store.all().find((i) => i.entityType === 'TaskCompletion');
    expect(adaRow?.completedBy).toBe(ADA.userId);

    // Sam waters it too, four minutes later — held, nothing written.
    const held = await invokeHandler(tasksHandler.completeTask, {
      method: 'POST',
      routeKey: 'POST /tasks/{id}/complete',
      pathParameters: { id: taskId },
      identity: { ...SAM, householdId },
      body: {},
    });
    expect(held.statusCode).toBe(409);
    const heldBody = held.body as {
      message: string;
      details: { code: string; plantName: string; duplicate: Record<string, unknown> };
    };
    expect(heldBody.details.code).toBe('DUPLICATE_CARE');
    expect(heldBody.details.plantName).toBe('Fern');
    expect(heldBody.details.duplicate).toMatchObject({
      completionId: adaRow?.id,
      completedByName: 'Ada Admin',
      taskId,
      taskType: 'water',
      sameTask: true,
      windowHours: 24,
    });
    expect(store.all().filter((i) => i.entityType === 'TaskCompletion')).toHaveLength(1);

    // Sam says "log it anyway".
    const confirmed = await invokeHandler(tasksHandler.completeTask, {
      method: 'POST',
      routeKey: 'POST /tasks/{id}/complete',
      pathParameters: { id: taskId },
      identity: { ...SAM, householdId },
      body: { confirmDuplicate: true },
    });
    expect(confirmed.statusCode).toBe(200);
    const rows = store.all().filter((i) => i.entityType === 'TaskCompletion');
    expect(rows).toHaveLength(2);
    const samRow = rows.find((r) => r.completedBy === SAM.userId);
    expect(samRow?.duplicateOfCompletionId).toBe(adaRow?.id);
    expect(adaRow?.duplicateOfCompletionId ?? null).toBeNull();

    // The analytics payload counts exactly that one confirmed duplicate.
    const analytics = await invokeHandler(householdsHandler.getDailyAnalytics, {
      method: 'GET',
      routeKey: 'GET /households/{id}/analytics/daily',
      pathParameters: { id: householdId },
      identity: { ...ADA, householdId },
    });
    expect(analytics.statusCode).toBe(200);
    expect((analytics.body as { doubleCare: unknown }).doubleCare).toEqual({
      status: 'ok',
      month: new Date().toISOString().slice(0, 7),
      confirmedDuplicates: 1,
    });
  });

  it('stays silent on the free tier and reports not_in_plan in analytics', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const { householdId, taskId } = await seedGardenWithWateringTask();
    await setHouseholdPlan(store, householdId, 'seedling');

    for (const who of [ADA, SAM]) {
      const res = await invokeHandler(tasksHandler.completeTask, {
        method: 'POST',
        routeKey: 'POST /tasks/{id}/complete',
        pathParameters: { id: taskId },
        identity: { ...who, householdId },
        body: {},
      });
      expect(res.statusCode).toBe(200);
    }
    const rows = store.all().filter((i) => i.entityType === 'TaskCompletion');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.duplicateOfCompletionId === null)).toBe(true);

    const analytics = await invokeHandler(householdsHandler.getDailyAnalytics, {
      method: 'GET',
      routeKey: 'GET /households/{id}/analytics/daily',
      pathParameters: { id: householdId },
      identity: { ...ADA, householdId },
    });
    expect((analytics.body as { doubleCare: unknown }).doubleCare).toEqual({
      status: 'not_in_plan',
    });
  });
});

describe('schedule drift: an 11-day fern on a 7-day schedule', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 6, n, 9)).toISOString(); // July n

  it('suggests matching, and one tap updates the frequency with an audited event', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const { householdId, plantId, taskId } = await seedGardenWithWateringTask();
    [1, 12, 23, 34].forEach((n, i) =>
      putCompletion(householdId, plantId, taskId, day(n), ADA, `c-${i}`)
    );

    const drift = await invokeHandler(tasksHandler.getPlantScheduleDrift, {
      method: 'GET',
      routeKey: 'GET /plants/{plantId}/schedule-drift',
      pathParameters: { plantId },
      identity: { ...ADA, householdId },
    });
    expect(drift.statusCode).toBe(200);
    expect(drift.body).toEqual({
      available: true,
      reason: null,
      tasks: [
        {
          taskId,
          scheduledIntervalDays: 7,
          completionsConsidered: 4,
          requiredCompletions: 4,
          drift: {
            medianIntervalDays: 11,
            driftPct: 0.571,
            suggestedFrequency: 11,
            exceedsThreshold: true,
          },
          reason: null,
        },
      ],
    });

    const matched = await invokeHandler(tasksHandler.matchTaskSchedule, {
      method: 'POST',
      routeKey: 'POST /tasks/{id}/match-schedule',
      pathParameters: { id: taskId },
      identity: { ...SAM, householdId },
      body: {},
    });
    expect(matched.statusCode).toBe(200);
    expect((matched.body as { frequency: number }).frequency).toBe(11);

    const activity = await invokeHandler(householdsHandler.getActivity, {
      method: 'GET',
      routeKey: 'GET /households/{id}/activity',
      pathParameters: { id: householdId },
      identity: { ...ADA, householdId },
    });
    const event = (
      activity.body as Array<{ type: string; actorName: string; payload: unknown }>
    ).find((e) => e.type === 'task.schedule_matched');
    expect(event).toMatchObject({
      actorName: 'Sam Member',
      payload: { taskId, previousFrequency: 7, newFrequency: 11, completionsConsidered: 4 },
    });
  });

  it('says drift: null with a reason below four completions, and the tap is refused', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const { householdId, plantId, taskId } = await seedGardenWithWateringTask();
    [1, 12, 23].forEach((n, i) =>
      putCompletion(householdId, plantId, taskId, day(n), ADA, `c-${i}`)
    );

    const drift = await invokeHandler(tasksHandler.getPlantScheduleDrift, {
      method: 'GET',
      routeKey: 'GET /plants/{plantId}/schedule-drift',
      pathParameters: { plantId },
      identity: { ...ADA, householdId },
    });
    expect((drift.body as { tasks: unknown[] }).tasks).toEqual([
      {
        taskId,
        scheduledIntervalDays: 7,
        completionsConsidered: 3,
        requiredCompletions: 4,
        drift: null,
        reason: 'insufficient_completions',
      },
    ]);

    const matched = await invokeHandler(tasksHandler.matchTaskSchedule, {
      method: 'POST',
      routeKey: 'POST /tasks/{id}/match-schedule',
      pathParameters: { id: taskId },
      identity: { ...ADA, householdId },
      body: {},
    });
    expect(matched.statusCode).toBe(409);
    const task = store.all().find((i) => i.SK === `TASK#${taskId}`);
    expect(task?.frequency).toBe(7);
  });
});
