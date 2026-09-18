/**
 * Real-handler integration tests for the household trash (#670).
 *
 * Runs the REAL plants / tasks / households / me / api / plantTags handlers
 * through the REAL middy chain against the REAL services on the in-memory
 * single table (see ./README.md), because the claim spans every surface at
 * once: a deleted plant must disappear from the lists, the reminder scan,
 * the digest, the public API, the sitter / kiosk / tag / share token views,
 * the calendar feed and the export — and all of it must come back on restore.
 *
 * Every address here is `example.invalid`; every string is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold, setHouseholdPlan } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));
vi.mock('../../src/services/cognitoUsers.js', () => ({
  getUserName: async () => 'Ada Admin',
  getUserEmail: async () => null,
  getUsersByIds: async () => new Map(),
  getHouseholdClaims: async () => ({ householdId: null, role: null }),
  setHouseholdClaims: async () => undefined,
  clearHouseholdClaims: async () => undefined,
  deleteUser: async () => undefined,
}));
vi.mock('../../src/services/billingEmails.js', async (orig) => ({
  ...(await orig<typeof import('../../src/services/billingEmails.js')>()),
  sendAccountDeletionEmail: async () => true,
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.invalid', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.invalid', name: 'Mel Member' };
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString();

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  vi.stubEnv('FRONTEND_URL', 'https://app.example.invalid');
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
});

const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
  vi.unstubAllEnvs();
});

interface World {
  householdId: string;
  plantId: string;
  taskId: string;
  sitterToken: string;
  kioskToken: string;
  tagToken: string;
  shareCode: string;
  calendarToken: string;
  apiKey: string;
}

/** A Greenhouse household with one plant wired into every surface. */
async function buildWorld(): Promise<World> {
  const plantService = await import('../../src/services/plantService.js');
  const taskService = await import('../../src/services/taskService.js');
  const apiKeys = await import('../../src/services/apiKeys.js');
  const households = await import('../../src/handlers/households/handler.js');
  const kioskLink = await import('../../src/handlers/households/kioskLink.js');
  const tags = await import('../../src/handlers/plantTags/handler.js');
  const plants = await import('../../src/handlers/plants/handler.js');
  const me = await import('../../src/handlers/me/handler.js');

  const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
  await setHouseholdPlan(store, householdId, 'greenhouse');
  const plant = await plantService.createPlant(
    { name: 'Monstera', notes: 'private note' },
    householdId,
    ADMIN.userId,
    5000
  );
  const task = await taskService.createTask(
    { plantId: plant.id, type: 'water', frequency: 7, nextDue: inDays(0) },
    householdId,
    ADMIN.userId,
    'Monstera'
  );
  await taskService.completeTask(householdId, task.id, MEMBER.userId, MEMBER.name);
  // A second task still due now, so the kiosk and sitter windows list it
  // (the completed one has moved a week out).
  await taskService.createTask(
    { plantId: plant.id, type: 'fertilize', frequency: 30, nextDue: inDays(0) },
    householdId,
    ADMIN.userId,
    'Monstera'
  );
  await plantService.appendPlantPhoto(
    householdId,
    plant.id,
    `https://cdn.example.invalid/plants/${householdId}/${plant.id}/leaf.jpg`,
    MEMBER.userId,
    'new leaf'
  );

  const admin = { ...ADMIN, householdId };
  const sitter = await invokeHandler(households.createSitterLink, {
    method: 'POST',
    routeKey: 'POST /households/{id}/sitter-links',
    pathParameters: { id: householdId },
    identity: admin,
    body: { expiresAt: inDays(14), label: 'Trip' },
  });
  expect(sitter.statusCode).toBe(201);
  const kiosk = await invokeHandler(kioskLink.issueKioskLink, {
    method: 'POST',
    routeKey: 'POST /households/{id}/kiosk-link',
    pathParameters: { id: householdId },
    identity: admin,
  });
  expect(kiosk.statusCode).toBe(201);
  const tag = await invokeHandler(tags.issuePlantTag, {
    method: 'POST',
    routeKey: 'POST /plants/{plantId}/tag',
    pathParameters: { plantId: plant.id },
    identity: admin,
  });
  expect(tag.statusCode).toBe(201);
  const share = await invokeHandler(plants.sharePlant, {
    method: 'POST',
    routeKey: 'POST /plants/{id}/share',
    pathParameters: { id: plant.id },
    identity: admin,
  });
  expect(share.statusCode).toBe(201);
  const calendar = await invokeHandler(me.createCalendarToken, {
    method: 'POST',
    routeKey: 'POST /me/calendar-token',
    identity: admin,
  });
  expect(calendar.statusCode).toBe(201);
  const key = await apiKeys.createApiKey(householdId, ADMIN.userId, 'integration');

  return {
    householdId,
    plantId: plant.id,
    taskId: task.id,
    sitterToken: (sitter.body as { token: string }).token,
    kioskToken: (kiosk.body as { token: string }).token,
    tagToken: (tag.body as { token: string }).token,
    shareCode: (share.body as { code: string }).code,
    calendarToken: (calendar.body as { token: string }).token,
    apiKey: key.plaintext,
  };
}

/** What every surface says about the plant right now. */
async function surfaces(world: World) {
  const plants = await import('../../src/handlers/plants/handler.js');
  const tasks = await import('../../src/handlers/tasks/handler.js');
  const kiosk = await import('../../src/handlers/tasks/kiosk.js');
  const tags = await import('../../src/handlers/plantTags/handler.js');
  const me = await import('../../src/handlers/me/handler.js');
  const api = await import('../../src/handlers/api/handler.js');
  const identity = { ...ADMIN, householdId: world.householdId };
  const [list, detail, taskList, sitter, kioskView, tag, share, feed, exported, apiPlant] =
    await Promise.all([
      invokeHandler(plants.listPlants, { method: 'GET', routeKey: 'GET /plants', identity }),
      invokeHandler(plants.getPlant, {
        method: 'GET',
        routeKey: 'GET /plants/{id}',
        pathParameters: { id: world.plantId },
        identity,
      }),
      invokeHandler(tasks.listTasks, { method: 'GET', routeKey: 'GET /tasks', identity }),
      invokeHandler(tasks.getSitterView, {
        method: 'GET',
        routeKey: 'GET /sitter/{token}',
        pathParameters: { token: world.sitterToken },
      }),
      invokeHandler(kiosk.getKioskView, {
        method: 'GET',
        routeKey: 'GET /kiosk/{token}',
        pathParameters: { token: world.kioskToken },
      }),
      invokeHandler(tags.getTagView, {
        method: 'GET',
        routeKey: 'GET /tag/{token}',
        pathParameters: { token: world.tagToken },
      }),
      invokeHandler(plants.getSharedPlant, {
        method: 'GET',
        routeKey: 'GET /plants/shared/{code}',
        pathParameters: { code: world.shareCode },
      }),
      invokeHandler(me.calendarFeed, {
        method: 'GET',
        routeKey: 'GET /calendar/{token}/family-greenhouse.ics',
        pathParameters: { token: world.calendarToken },
      }),
      invokeHandler(me.exportMe, { method: 'GET', routeKey: 'GET /me/export', identity }),
      invokeHandler(api.getPlant, {
        method: 'GET',
        routeKey: 'GET /api/v1/plants/{id}',
        pathParameters: { id: world.plantId },
        headers: { authorization: `Bearer ${world.apiKey}` },
      }),
    ]);
  // The hourly reminder scan's due-window read, and the weekly digest's
  // at-risk read, a fortnight out so the due task counts as overdue.
  const taskService = await import('../../src/services/taskService.js');
  const digestReport = await import('../../src/services/digestReport.js');
  const due = await taskService.getTasksDueBy(world.householdId, inDays(1));
  const atRisk = await digestReport.gatherAtRisk(world.householdId, new Date(inDays(14)));
  return {
    reminderDue: due.some((task) => task.plantId === world.plantId),
    digestAtRisk: JSON.stringify(atRisk).includes(world.plantId),
    listed: JSON.stringify(list.body).includes(world.plantId),
    detail: detail.statusCode,
    taskListed: JSON.stringify(taskList.body).includes(world.taskId),
    sitterStatus: sitter.statusCode,
    sitterListed: JSON.stringify(sitter.body).includes('Monstera'),
    kioskStatus: kioskView.statusCode,
    kioskListed: JSON.stringify(kioskView.body).includes('Monstera'),
    tag: tag.statusCode,
    share: share.statusCode,
    feedListed: String(feed.body).includes('Monstera'),
    exported: JSON.stringify(exported.body).includes(world.plantId),
    apiPlant: apiPlant.statusCode,
  };
}

const PRESENT = {
  reminderDue: true,
  digestAtRisk: true,
  listed: true,
  detail: 200,
  taskListed: true,
  sitterStatus: 200,
  sitterListed: true,
  kioskStatus: 200,
  kioskListed: true,
  tag: 200,
  share: 200,
  feedListed: true,
  exported: true,
  apiPlant: 200,
};

async function trashRoute(
  routeKey: string,
  method: string,
  world: World,
  path: Record<string, string> = {},
  who = ADMIN
) {
  const households = await import('../../src/handlers/households/handler.js');
  return invokeHandler(households.handler, {
    method,
    routeKey,
    pathParameters: { id: world.householdId, ...path },
    identity: { ...who, householdId: world.householdId },
  });
}

describe('DELETE /plants/{id} → trash → restore', () => {
  it('disappears from every surface, is listed in the trash, and comes back on every surface', async () => {
    const plants = await import('../../src/handlers/plants/handler.js');
    const world = await buildWorld();
    // Negative control: the fixture really is visible everywhere first, so
    // "absent" below cannot pass on a surface that never showed it.
    expect(await surfaces(world)).toEqual(PRESENT);

    const del = await invokeHandler(plants.deletePlant, {
      method: 'DELETE',
      routeKey: 'DELETE /plants/{id}',
      pathParameters: { id: world.plantId },
      identity: { ...MEMBER, householdId: world.householdId },
    });
    expect(del.statusCode).toBe(204);

    expect(await surfaces(world)).toEqual({
      reminderDue: false,
      digestAtRisk: false,
      listed: false,
      detail: 404,
      taskListed: false,
      sitterStatus: 200,
      sitterListed: false,
      kioskStatus: 200,
      kioskListed: false,
      tag: 404,
      share: 404,
      feedListed: false,
      exported: false,
      apiPlant: 404,
    });

    const listing = await trashRoute('GET /households/{id}/trash', 'GET', world);
    expect(listing.statusCode).toBe(200);
    const body = listing.body as { retentionDays: number; entries: Array<Record<string, unknown>> };
    expect(body.retentionDays).toBe(30);
    expect(body.entries).toEqual([
      expect.objectContaining({
        kind: 'plant',
        id: world.plantId,
        name: 'Monstera',
        deletedByName: MEMBER.name,
        contents: { tasks: 2, photos: 1, completions: 1 },
      }),
    ]);
    // A projection: the plant's free-text note never rides the listing.
    expect(JSON.stringify(body)).not.toContain('private note');

    const restored = await trashRoute(
      'POST /households/{id}/trash/{kind}/{itemId}/restore',
      'POST',
      world,
      { kind: 'plant', itemId: world.plantId }
    );
    expect(restored.statusCode).toBe(200);
    expect(await surfaces(world)).toEqual(PRESENT);

    const types = store
      .all()
      .filter((r) => r.entityType === 'ActivityEvent')
      .map(
        (r) =>
          `${String(r.type)}${(r.payload as { fromTrash?: boolean }).fromTrash ? ':trash' : ''}`
      );
    expect(types).toEqual(expect.arrayContaining(['plant.trashed', 'plant.restored:trash']));
  });

  it('refuses a restore into a household at its plant cap with the documented words', async () => {
    const plantService = await import('../../src/services/plantService.js');
    const trashService = await import('../../src/services/trashService.js');
    const { getPlan, limitOf } = await import('../../src/models/plans.js');
    const cap = limitOf(getPlan('seedling'), 'plants') as number;
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const world = { householdId } as World;
    const plant = await plantService.createPlant({ name: 'Fern' }, householdId, ADMIN.userId, cap);
    await trashService.trashPlant(householdId, plant.id, {
      userId: ADMIN.userId,
      name: ADMIN.name,
    });
    // Trashing freed the slot; filling it puts the household AT its cap.
    for (let i = 0; i < cap; i += 1) {
      await plantService.createPlant({ name: `Filler ${i}` }, householdId, ADMIN.userId, cap);
    }

    const res = await trashRoute(
      'POST /households/{id}/trash/{kind}/{itemId}/restore',
      'POST',
      world,
      { kind: 'plant', itemId: plant.id }
    );
    expect(res.statusCode).toBe(402);
    // The same words POST /plants uses at the cap.
    expect(res.body).toMatchObject({
      message: `Your Seedling plan is limited to ${cap} plants. Remove or archive a plant before adding more.`,
    });
    expect(await trashService.getEntry(householdId, 'plant', plant.id)).not.toBeNull();
  });

  it('answers 409 for a task whose plant is in the trash too, and 404 for a missing entry', async () => {
    const tasks = await import('../../src/handlers/tasks/handler.js');
    const plants = await import('../../src/handlers/plants/handler.js');
    const world = await buildWorld();
    const identity = { ...ADMIN, householdId: world.householdId };
    const delTask = await invokeHandler(tasks.deleteTask, {
      method: 'DELETE',
      routeKey: 'DELETE /tasks/{id}',
      pathParameters: { id: world.taskId },
      identity,
    });
    expect(delTask.statusCode).toBe(204);
    await invokeHandler(plants.deletePlant, {
      method: 'DELETE',
      routeKey: 'DELETE /plants/{id}',
      pathParameters: { id: world.plantId },
      identity,
    });

    const blocked = await trashRoute(
      'POST /households/{id}/trash/{kind}/{itemId}/restore',
      'POST',
      world,
      { kind: 'task', itemId: world.taskId }
    );
    expect(blocked.statusCode).toBe(409);
    expect((blocked.body as { message: string }).message).toMatch(/Restore the plant first/);

    const missing = await trashRoute(
      'POST /households/{id}/trash/{kind}/{itemId}/restore',
      'POST',
      world,
      { kind: 'plant', itemId: 'no-such-plant' }
    );
    expect(missing.statusCode).toBe(404);

    const badKind = await trashRoute(
      'DELETE /households/{id}/trash/{kind}/{itemId}',
      'DELETE',
      world,
      {
        kind: 'photo',
        itemId: world.plantId,
      }
    );
    expect(badKind.statusCode).toBe(400);
  });

  it('deletes now: permanent, idempotent to a 404, and scoped to the caller’s household', async () => {
    const world = await buildWorld();
    const plants = await import('../../src/handlers/plants/handler.js');
    await invokeHandler(plants.deletePlant, {
      method: 'DELETE',
      routeKey: 'DELETE /plants/{id}',
      pathParameters: { id: world.plantId },
      identity: { ...ADMIN, householdId: world.householdId },
    });

    // Another household's member cannot reach this trash.
    const other = await seedHousehold(store, {
      admin: { userId: 'user-other', email: 'other@example.invalid', name: 'Oz Other' },
    });
    const households = await import('../../src/handlers/households/handler.js');
    const foreign = await invokeHandler(households.handler, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{id}/trash/{kind}/{itemId}',
      pathParameters: { id: world.householdId, kind: 'plant', itemId: world.plantId },
      identity: {
        userId: 'user-other',
        email: 'other@example.invalid',
        householdId: other.householdId,
      },
    });
    expect(foreign.statusCode).toBe(403);

    const purged = await trashRoute(
      'DELETE /households/{id}/trash/{kind}/{itemId}',
      'DELETE',
      world,
      {
        kind: 'plant',
        itemId: world.plantId,
      }
    );
    expect(purged.statusCode).toBe(204);
    const again = await trashRoute(
      'DELETE /households/{id}/trash/{kind}/{itemId}',
      'DELETE',
      world,
      {
        kind: 'plant',
        itemId: world.plantId,
      }
    );
    expect(again.statusCode).toBe(404);
    // Only the history still names it: the activity log, as a delete always
    // left, and the household audit log (#675), whose entries expire on their
    // own retention and are erased with the household.
    const mentions = store
      .all()
      .filter((r) => JSON.stringify(r).includes(world.plantId))
      .filter((r) => !String(r.PK).endsWith('#ACTIVITY') && !String(r.PK).endsWith('#AUDIT'));
    expect(mentions).toEqual([]);
  });
});

describe('DELETE /me erases the trash too', () => {
  it('leaves no trashed row behind for a sole-member household, whatever its age', async () => {
    const plantService = await import('../../src/services/plantService.js');
    const taskService = await import('../../src/services/taskService.js');
    const trashService = await import('../../src/services/trashService.js');
    const me = await import('../../src/handlers/me/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const plant = await plantService.createPlant({ name: 'Fern' }, householdId, ADMIN.userId, 10);
    const task = await taskService.createTask(
      { plantId: plant.id, type: 'water', frequency: 7 },
      householdId,
      ADMIN.userId,
      'Fern'
    );
    await taskService.completeTask(householdId, task.id, ADMIN.userId, ADMIN.name);
    // Trashed a minute ago: well inside the window the listing would honour.
    await trashService.trashPlant(householdId, plant.id, {
      userId: ADMIN.userId,
      name: ADMIN.name,
    });
    expect(store.all().some((r) => String(r.PK).includes('#TRASH#'))).toBe(true);

    const res = await invokeHandler(me.deleteMe, {
      method: 'DELETE',
      routeKey: 'DELETE /me',
      identity: { ...ADMIN, householdId },
    });
    expect(res.statusCode).toBe(204);
    expect(store.all().filter((r) => JSON.stringify(r).includes(householdId))).toEqual([]);
  });

  it('scrubs a departing member from a shared household’s trash', async () => {
    const plantService = await import('../../src/services/plantService.js');
    const taskService = await import('../../src/services/taskService.js');
    const trashService = await import('../../src/services/trashService.js');
    const me = await import('../../src/handlers/me/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    const plant = await plantService.createPlant({ name: 'Fern' }, householdId, MEMBER.userId, 10);
    const task = await taskService.createTask(
      { plantId: plant.id, type: 'water', frequency: 7 },
      householdId,
      MEMBER.userId,
      'Fern'
    );
    await taskService.completeTask(householdId, task.id, MEMBER.userId, MEMBER.name);
    await trashService.trashPlant(householdId, plant.id, {
      userId: MEMBER.userId,
      name: MEMBER.name,
    });

    const res = await invokeHandler(me.deleteMe, {
      method: 'DELETE',
      routeKey: 'DELETE /me',
      identity: { ...MEMBER, householdId },
    });
    expect(res.statusCode).toBe(204);
    const trashed = store
      .all()
      .filter((r) => String(r.PK).includes('#TRASH#') || String(r.SK).startsWith('TRASH#'));
    expect(trashed.length).toBeGreaterThan(0);
    expect(JSON.stringify(trashed)).not.toContain(MEMBER.userId);
    expect(JSON.stringify(trashed)).not.toContain(MEMBER.name);
  });
});
