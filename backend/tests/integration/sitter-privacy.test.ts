/**
 * The published sitter-link privacy paragraph, checked against what a sitter
 * link actually returns (#709).
 *
 * `legal.privacy.sitter.body` is a promise to every household that shares a
 * link — free and trial households included — about an
 * unauthenticated, bearer-credential read surface. It was wrong: it said
 * "sitter links do not expose ... plant or task private notes", and the brief
 * returned `plant.notes` word for word whenever the plant had no house rule
 * (the ADR 0015 (d) fallback, withdrawn in the same change as this file).
 *
 * Nothing else in the repository could have caught that. The unit tests assert
 * the resolver's behaviour, and the copy lives in a JSON catalog; no test read
 * both. This one does: it builds a real link through the real
 * `POST /households/{id}/sitter-links` handler, fetches both public sitter
 * routes with NO credential but the token, and asserts each clause of the
 * published sentence against the bytes that come back — in both locales, so a
 * Spanish twin cannot promise something the English one does not.
 *
 * HOW IT FAILS. Every assertion here is reachable from a one-line code change:
 * put the `notes` fallback back in `models/sitterBriefFields.ts` and
 * "no plant private notes" goes red; widen the sitter projection and the
 * household-location, member-identity or task-note assertions go red; drop a
 * clause from the catalog and the copy assertions go red. It is deliberately
 * NOT a snapshot: a snapshot would record a leak as the expected value.
 *
 * Every string planted here is synthetic.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold, setHouseholdPlan } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));
// Only the AWS boundary is faked. Signing is real crypto against a real role
// in production; here it just has to produce a URL so the photo clause is
// checkable.
vi.mock('../../src/utils/s3.js', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/s3.js')>();
  return {
    ...actual,
    signedImageUrl: async (key: string, ttl: number) => `https://signed.example/${key}?ttl=${ttl}`,
  };
});
vi.mock('../../src/services/cognitoUsers.js', () => ({
  getUserName: async () => 'Ada Admin',
  getUserEmail: async () => null,
  getUsersByIds: async () => new Map(),
}));

const ADMIN = { userId: 'user-admin', email: 'fixture-admin-contact', name: 'Ada Admin' };
/** A plain member, not an admin — the paragraph says "a household member". */
const MEMBER = { userId: 'user-member', email: 'fixture-member-contact', name: 'Mel Member' };

/**
 * Synthetic markers, one per thing the paragraph makes a claim about. Every
 * one is searched for in the raw response bytes, so a leak through a field
 * this test does not know the name of still fails.
 */
const PLANT_PRIVATE_NOTE = 'PRIVATENOTE-7Q2 the spare key is under the mat';
const PLANT_SECOND_PRIVATE_NOTE = 'PRIVATENOTE-9Z8 alarm code';
const TASK_PRIVATE_NOTE = 'TASKNOTE-8M4 use the private measuring cup';
const HOUSEHOLD_CITY = 'HHCITY-EPSILON';
const HOUSEHOLD_NAME = 'HHNAME-OMICRON';
const PLACEMENT_NOTE = 'PLACEMENT-3X9 east window, top shelf';
const SPACE_NAME = 'SPACENAME-THETA';
const PLANT_NAME = 'PLANTNAME-IOTA';
const HOUSE_RULE = 'CARERULE-5K1 bottom-water only';

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString();

const ROOT = new URL('../../../', import.meta.url);
const sitterParagraph = (tag: 'en' | 'es'): string =>
  (
    JSON.parse(
      readFileSync(new URL(`frontend/src/i18n/locales/${tag}/legal.json`, ROOT), 'utf8')
    ) as { legal: { privacy: { sitter: { body: string } } } }
  ).legal.privacy.sitter.body;

interface Seeded {
  householdId: string;
  token: string;
  linkId: string;
  ruledPlantId: string;
  unruledPlantId: string;
  taskId: string;
}

/**
 * A household exactly as the paragraph describes one: two members, a saved
 * climate location, a named space, a plant WITH a house rule and a private
 * note, a plant with a private note and NO house rule (the case the withdrawn
 * fallback used to leak), a photo, and a task carrying a private note.
 */
async function seedEverything(): Promise<Seeded> {
  const householdsHandler = await import('../../src/handlers/households/handler.js');
  const plantService = await import('../../src/services/plantService.js');
  const spaceService = await import('../../src/services/spaceService.js');
  const taskService = await import('../../src/services/taskService.js');
  const householdService = await import('../../src/services/householdService.js');

  const { householdId } = await seedHousehold(store, {
    name: HOUSEHOLD_NAME,
    admin: ADMIN,
    members: [MEMBER],
  });
  // Greenhouse: the brief and the photo-back are the paid half, and the
  // paragraph has to be true on the tier that exposes the most.
  await setHouseholdPlan(store, householdId, 'greenhouse');
  await householdService.setHouseholdLocation(householdId, {
    city: HOUSEHOLD_CITY,
    latitude: 34.05,
    longitude: -118.24,
  });

  const space = await spaceService.createSpace({ name: SPACE_NAME }, householdId, ADMIN.userId);

  const ruled = await plantService.createPlant(
    {
      name: PLANT_NAME,
      species: 'Monstera deliciosa',
      notes: PLANT_PRIVATE_NOTE,
      placementNote: PLACEMENT_NOTE,
      careRule: HOUSE_RULE,
    },
    householdId,
    ADMIN.userId,
    5000
  );
  await plantService.updatePlant(householdId, ruled.id, { spaceId: space.id }, 5000);
  // The photo is set on the row directly: the upload path is an S3 round trip
  // and the claim under test is about what the brief HANDS OUT, not how the
  // object got there. The key shape is the one `plantImageKeyForHousehold`
  // accepts, so this exercises the real signing branch.
  const row = store.all().find((i) => i.SK === `PLANT#${ruled.id}`);
  expect(row, 'the seeded plant row must exist before its photo is attached').toBeTruthy();
  store.put({
    ...row,
    imageUrl: `https://cdn.fixture.invalid/plants/${householdId}/${ruled.id}/pic1.jpg`,
  });

  const unruled = await plantService.createPlant(
    { name: 'PLANTNAME-KAPPA', notes: PLANT_SECOND_PRIVATE_NOTE },
    householdId,
    ADMIN.userId,
    5000
  );

  const task = await taskService.createTask(
    {
      plantId: ruled.id,
      type: 'water',
      frequency: 7,
      nextDue: inDays(1),
      notes: TASK_PRIVATE_NOTE,
    },
    householdId,
    ADMIN.userId,
    PLANT_NAME
  );

  // "A household member can create a temporary sitter link" — a plain member,
  // through the real authed handler.
  const created = await invokeHandler(householdsHandler.createSitterLink, {
    method: 'POST',
    routeKey: 'POST /households/{id}/sitter-links',
    pathParameters: { id: householdId },
    identity: { ...MEMBER, householdId },
    body: { expiresAt: inDays(7), label: 'Trip' },
  });
  expect(created.statusCode).toBe(201);
  const body = created.body as { token: string; id: string };

  return {
    householdId,
    token: body.token,
    linkId: body.id,
    ruledPlantId: ruled.id,
    unruledPlantId: unruled.id,
    taskId: task.id,
  };
}

/** Both public reads, with NO credential but the token in the path. */
async function readAsSitter(token: string) {
  const tasksHandler = await import('../../src/handlers/tasks/handler.js');
  const view = await invokeHandler(tasksHandler.getSitterView, {
    method: 'GET',
    routeKey: 'GET /sitter/{token}',
    pathParameters: { token },
  });
  const brief = await invokeHandler(tasksHandler.getSitterBrief, {
    method: 'GET',
    routeKey: 'GET /sitter/{token}/brief',
    pathParameters: { token },
  });
  return { view, brief, wire: JSON.stringify({ view: view.body, brief: brief.body }) };
}

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  process.env.FRONTEND_URL = 'https://app.fixture.invalid';
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
});

const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('the published sitter paragraph still says what this test checks', () => {
  // If a clause is reworded, this fails and whoever reworded it has to come
  // here and decide whether the assertion below still measures the promise.
  // That is the point: the copy and the check move together or not at all.
  it.each([
    ['en', 'do not expose your saved household location, plant or task private notes'],
    ['en', 'household member identity and contact details'],
    ['en', 'bearer credential'],
    ['en', 'at most 90 days'],
    ['en', 'do not ask for or store the sitter'],
    ['es', 'no exponen la ubicación guardada de tu hogar, las notas privadas de plantas o tareas'],
    ['es', 'identidad y los datos de contacto de los miembros del hogar'],
    ['es', 'credencial al portador'],
    ['es', 'máximo a los 90 días'],
    ['es', 'No pedimos ni almacenamos la identidad'],
  ] as const)('%s privacy policy still contains "%s"', (tag, clause) => {
    expect(sitterParagraph(tag)).toContain(clause);
  });
});

describe('what a sitter link exposes, measured against that paragraph', () => {
  it('"can see due care tasks, plant names, each plant’s current space, and its short placement note"', async () => {
    const seeded = await seedEverything();
    const { view, brief } = await readAsSitter(seeded.token);

    expect(view.statusCode).toBe(200);
    expect(brief.statusCode).toBe(200);

    const tasks = (view.body as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: seeded.taskId,
      plantName: PLANT_NAME,
      spaceName: SPACE_NAME,
      placementNote: PLACEMENT_NOTE,
    });
  });

  it('"do not expose ... plant ... private notes" — not even when the plant has no house rule (#709)', async () => {
    const seeded = await seedEverything();
    const { brief, wire } = await readAsSitter(seeded.token);

    // The exact regression: a plant with a house rule shows the rule, and a
    // plant WITHOUT one shows nothing — never the long-form private note.
    const plants = (brief.body as { plants: Array<Record<string, unknown>> }).plants;
    const ruled = plants.find((p) => p.plantId === seeded.ruledPlantId);
    const unruled = plants.find((p) => p.plantId === seeded.unruledPlantId);
    expect(ruled).toMatchObject({ careNote: HOUSE_RULE, careNoteSource: 'rule' });
    expect(unruled).toMatchObject({ careNote: null, careNoteSource: null });

    // And the bytes, so a leak through some other field is caught too.
    expect(wire).not.toContain(PLANT_PRIVATE_NOTE);
    expect(wire).not.toContain(PLANT_SECOND_PRIVATE_NOTE);
  });

  it('"do not expose ... task private notes"', async () => {
    const seeded = await seedEverything();
    const { wire } = await readAsSitter(seeded.token);
    expect(wire).not.toContain(TASK_PRIVATE_NOTE);
  });

  it('"do not expose your saved household location"', async () => {
    const seeded = await seedEverything();
    const { wire } = await readAsSitter(seeded.token);
    expect(wire).not.toContain(HOUSEHOLD_CITY);
    expect(wire).not.toContain('34.05');
    expect(wire).not.toContain('-118.24');
  });

  it('"do not expose ... household member identity and contact details"', async () => {
    const seeded = await seedEverything();
    const { wire } = await readAsSitter(seeded.token);
    for (const secret of [
      ADMIN.name,
      ADMIN.email,
      ADMIN.userId,
      MEMBER.name,
      MEMBER.email,
      MEMBER.userId,
      HOUSEHOLD_NAME,
    ]) {
      expect(wire, `a sitter payload must not contain "${secret}"`).not.toContain(secret);
    }
  });

  /**
   * Measured, and narrower than the comments used to claim. The handler and
   * ADR 0015 both said the sitter payload carries "no household id"; it does,
   * inside the signed photo URL, because the S3 key is
   * `plants/{householdId}/{plantId}/{file}` and a presigned URL cannot hide
   * the key it signs. The published privacy paragraph does not promise
   * otherwise — an opaque household UUID is neither a saved location, a
   * private note, nor a member identity, and it is handed only to a holder of
   * a live bearer token for that very household, who cannot use it to reach
   * anything (`authMiddleware` re-validates `X-Household-Id` against the
   * membership row). It is pinned here so the true shape is on the record:
   * the id appears in the photo URL and NOWHERE else.
   */
  it('carries the household id only inside the signed photo URL, and nowhere else', async () => {
    const seeded = await seedEverything();
    const { view, brief } = await readAsSitter(seeded.token);
    expect(JSON.stringify(view.body)).not.toContain(seeded.householdId);

    const plants = (brief.body as { plants: Array<Record<string, unknown>> }).plants;
    const withoutPhotos = plants.map(({ photoUrl: _photoUrl, ...rest }) => rest);
    expect(JSON.stringify({ ...(brief.body as object), plants: withoutPhotos })).not.toContain(
      seeded.householdId
    );
  });

  it('"the same link also opens a care brief" — the house rule, the pet-safety entry and a photo that dies with the link', async () => {
    const seeded = await seedEverything();
    const { brief } = await readAsSitter(seeded.token);
    const plants = (brief.body as { plants: Array<Record<string, unknown>> }).plants;
    const ruled = plants.find((p) => p.plantId === seeded.ruledPlantId)!;

    expect(ruled.careNote).toBe(HOUSE_RULE);
    expect(ruled.petSafety).toMatchObject({ slug: 'monstera', cats: 'toxic', dogs: 'toxic' });
    // A photo URL, and one whose lifetime is bounded by the link's (#453).
    expect(String(ruled.photoUrl)).toContain(`/${seeded.ruledPlantId}/pic1.jpg`);
    const ttl = Number(new URL(String(ruled.photoUrl)).searchParams.get('ttl'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60 * 60);
  });

  it('"can mark those tasks complete during the coverage window", and cannot once it is revoked', async () => {
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const seeded = await seedEverything();

    const done = await invokeHandler(tasksHandler.completeSitterTask, {
      method: 'POST',
      routeKey: 'POST /sitter/{token}/tasks/{taskId}/complete',
      pathParameters: { token: seeded.token, taskId: seeded.taskId },
      body: {},
    });
    expect(done.statusCode).toBe(200);

    // "a household member can revoke it sooner" — the member who minted it.
    const revoked = await invokeHandler(householdsHandler.revokeSitterLink, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{id}/sitter-links/{linkId}',
      pathParameters: { id: seeded.householdId, linkId: seeded.linkId },
      identity: { ...MEMBER, householdId: seeded.householdId },
    });
    expect(revoked.statusCode).toBe(204);

    const after = await readAsSitter(seeded.token);
    expect(after.view.statusCode).toBe(404);
    expect(after.brief.statusCode).toBe(404);
    const againstRevoked = await invokeHandler(tasksHandler.completeSitterTask, {
      method: 'POST',
      routeKey: 'POST /sitter/{token}/tasks/{taskId}/complete',
      pathParameters: { token: seeded.token, taskId: seeded.taskId },
      body: {},
    });
    expect(againstRevoked.statusCode).toBe(404);
  });

  it('"expires after at most 90 days"', async () => {
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const seeded = await seedEverything();
    const tooLong = await invokeHandler(householdsHandler.createSitterLink, {
      method: 'POST',
      routeKey: 'POST /households/{id}/sitter-links',
      pathParameters: { id: seeded.householdId },
      identity: { ...MEMBER, householdId: seeded.householdId },
      body: { expiresAt: inDays(91) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('"we do not ask for or store the sitter’s identity" — a completion records the link, not a person', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const seeded = await seedEverything();
    await invokeHandler(tasksHandler.completeSitterTask, {
      method: 'POST',
      routeKey: 'POST /sitter/{token}/tasks/{taskId}/complete',
      pathParameters: { token: seeded.token, taskId: seeded.taskId },
      body: {},
    });

    const completion = store
      .all()
      .filter((i) => String(i.PK ?? '').endsWith('#ACTIVITY'))
      .find((i) => i.type === 'task.completed');
    expect(completion).toBeTruthy();
    expect(completion!.actorName).toBe('a plant sitter');
    expect(completion!.actorId).toBe(`sitter:${seeded.linkId}`);
  });
});
