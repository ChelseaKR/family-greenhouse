/**
 * Plant passport (#676), end to end on the REAL handlers, middleware chain and
 * services over the in-memory single table. Only the AWS SDK boundary is fake,
 * so the conditional writes that make a replay lose are the real conditions.
 *
 * The scenario is two households that have never met. SOURCE hands a plant on;
 * RECIPIENT is a stranger holding a link. Everything a stranger's request can
 * do is tried, and each thing that must not happen is asserted from BOTH sides:
 * the recipient's household gets exactly what it should, and the source
 * household's rows are byte-for-byte what they were.
 *
 * Every address is `example.invalid`; every string is synthetic. The PRIVATE-*
 * strings are the household's own words: they are planted in every place a
 * plant, task or completion can hold free text, and must appear nowhere a
 * stranger can read or that a stranger's household receives.
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
  getUserName: async () => 'Someone',
  getHouseholdClaims: async () => ({ householdId: null, role: null }),
  setHouseholdClaims: async () => undefined,
  clearHouseholdClaims: async () => undefined,
  getUsersByIds: async () => new Map(),
  getUserEmail: async () => null,
}));

const ADA = { userId: 'user-ada', email: 'ada@example.invalid', name: 'Ada Source' };
const MEL = { userId: 'user-mel', email: 'mel@example.invalid', name: 'Mel Source' };
const RAE = { userId: 'user-rae', email: 'rae@example.invalid', name: 'Rae Recipient' };

const PRIVATE = {
  plantNote: 'PRIVATE-PLANT-NOTE spare key is under the flowerpot',
  taskNote: 'PRIVATE-TASK-NOTE water from the rain barrel',
  completionNote: 'PRIVATE-COMPLETION-NOTE it looked sad today',
  placement: 'PRIVATE-PLACEMENT behind the boiler',
};
const PRIVATE_MARKERS = [
  'PRIVATE-PLANT-NOTE',
  'PRIVATE-TASK-NOTE',
  'PRIVATE-COMPLETION-NOTE',
  'PRIVATE-PLACEMENT',
];

const DAY = 24 * 60 * 60 * 1000;

let source: { householdId: string; plantId: string; parentId: string };
let recipient: { householdId: string };

const asAda = (h: string) => ({ ...ADA, householdId: h, householdRole: 'admin' as const });
const asRae = (h: string) => ({ ...RAE, householdId: h, householdRole: 'admin' as const });

async function plantsHandler() {
  return (await import('../../src/handlers/plants/handler.js')).handler;
}

async function mint(identity = asAda(source.householdId), plantId = source.plantId) {
  return invokeHandler(await plantsHandler(), {
    method: 'POST',
    routeKey: 'POST /plants/{id}/passport-share',
    pathParameters: { id: plantId },
    identity,
  });
}

async function preview(code: string, path: 'card' | 'passport' = 'passport') {
  return invokeHandler(await plantsHandler(), {
    method: 'GET',
    routeKey:
      path === 'passport' ? 'GET /plants/shared/{code}/passport' : 'GET /plants/shared/{code}',
    pathParameters: { code },
  });
}

async function importPassport(
  code: string,
  opts: { identity?: ReturnType<typeof asRae>; body?: unknown } = {}
) {
  return invokeHandler(await plantsHandler(), {
    method: 'POST',
    routeKey: 'POST /plants/shared/{code}/passport/import',
    pathParameters: { code },
    identity: opts.identity ?? asRae(recipient.householdId),
    body: opts.body,
  });
}

async function plantsOf(householdId: string) {
  const plantService = await import('../../src/services/plantService.js');
  return plantService.getPlants(householdId, 'all');
}

/** Every stored item, as one string, for "appears nowhere" assertions. */
const everything = () => JSON.stringify(store.all());
const shareRows = () => store.all().filter((i) => String(i.PK).startsWith('SHARE#'));

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('FRONTEND_URL', 'https://app.example.invalid');
  vi.stubEnv('PASSPORT_IMPORT_ENABLED', '1');
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();

  const plantService = await import('../../src/services/plantService.js');
  const taskService = await import('../../src/services/taskService.js');

  const src = await seedHousehold(store, { name: 'The Reyes house', admin: ADA, members: [MEL] });
  await setHouseholdPlan(store, src.householdId, 'greenhouse');
  const parent = await plantService.createPlant(
    { name: 'Kitchen Pothos' },
    src.householdId,
    ADA.userId,
    5000
  );
  const plant = await plantService.createPlant(
    {
      name: 'Mother Monstera',
      species: 'Monstera deliciosa',
      notes: PRIVATE.plantNote,
      careRule: 'Bottom-water only',
      placementNote: PRIVATE.placement,
      parentPlantId: parent.id,
      tags: ['tropical'],
    },
    src.householdId,
    ADA.userId,
    5000
  );
  // A cutting taken from it, and a task with a completion, each with private notes.
  await plantService.createPlant(
    { name: 'Baby Monstera', parentPlantId: plant.id },
    src.householdId,
    ADA.userId,
    5000
  );
  const task = await taskService.createTask(
    {
      plantId: plant.id,
      type: 'water',
      frequency: 7,
      notes: PRIVATE.taskNote,
      seasonalCadences: [{ season: 'winter', frequency: 14 }],
      nextDue: new Date(Date.now() + DAY).toISOString(),
    },
    src.householdId,
    ADA.userId,
    'Mother Monstera'
  );
  await taskService.completeTask(
    src.householdId,
    task.id,
    MEL.userId,
    MEL.name,
    PRIVATE.completionNote
  );

  source = { householdId: src.householdId, plantId: plant.id, parentId: parent.id };

  // Seedling: the free tier's plant cap is what the recipient is held to.
  const rec = await seedHousehold(store, { name: 'Rae House', admin: RAE });
  recipient = { householdId: rec.householdId };
});

// Silence the pino request logger.
const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('while the feature is off (the default)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('FRONTEND_URL', 'https://app.example.invalid');
  });

  it('answers 404 PASSPORT_IMPORT_DISABLED on all three routes and writes nothing', async () => {
    const rowsBefore = store.all().length;
    const responses = [
      await mint(),
      await preview('a'.repeat(32)),
      await importPassport('a'.repeat(32)),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect((res.body as { details: { code: string } }).details.code).toBe(
        'PASSPORT_IMPORT_DISABLED'
      );
    }
    expect(store.all().length).toBe(rowsBefore);
  });

  it('leaves the cutting link exactly as it was, and mints none with a summary on it', async () => {
    const plants = await plantsHandler();
    const share = await invokeHandler(plants, {
      method: 'POST',
      routeKey: 'POST /plants/{id}/share',
      pathParameters: { id: source.plantId },
      identity: asAda(source.householdId),
    });
    expect(share.statusCode).toBe(201);
    const code = (share.body as { code: string }).code;
    const card = await preview(code, 'card');
    expect(card.statusCode).toBe(200);
    expect(Object.keys(card.body as object).sort()).toEqual([
      'expiresAt',
      'householdName',
      'plant',
    ]);
    expect(shareRows().every((row) => !('passport' in row))).toBe(true);

    const accepted = await invokeHandler(plants, {
      method: 'POST',
      routeKey: 'POST /plants/shared/{code}/accept',
      pathParameters: { code },
      identity: asRae(recipient.householdId),
    });
    expect(accepted.statusCode).toBe(201);
    expect((accepted.body as { notes: string }).notes).toBe('Cutting from The Reyes house');
  });
});

describe('making a passport link', () => {
  it('freezes a summary onto a cutting-share row and returns the /shared URL', async () => {
    const res = await mint();
    expect(res.statusCode).toBe(201);
    const { code, url, expiresAt } = res.body as { code: string; url: string; expiresAt: string };
    expect(url).toBe(`https://app.example.invalid/shared/${code}`);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 13 * DAY);

    const rows = shareRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe('PlantShare');
    expect(rows[0].passport).toMatchObject({
      version: 1,
      schedule: [{ type: 'water', frequency: 7, seasonal: [{ season: 'winter', frequency: 14 }] }],
      care: { loggedInWindow: 1, atLeast: false },
      lineage: { parentName: 'Kitchen Pothos', cuttingsTaken: 1 },
    });
    // The credential is hashed at rest, as for every other link (#450).
    expect(everything()).not.toContain(code);
  });

  it('puts none of the household’s private words, people or ids in anything stored', async () => {
    await mint();
    const stored = JSON.stringify(shareRows());
    for (const marker of PRIVATE_MARKERS) expect(stored).not.toContain(marker);
    expect(stored).not.toContain(MEL.name);
    expect(stored).not.toContain(MEL.userId);
    // The plant's own private note is still where it was: nothing was moved.
    const plants = await plantsOf(source.householdId);
    expect(plants.find((p) => p.id === source.plantId)?.notes).toBe(PRIVATE.plantNote);
  });

  it('will not make a link for a plant in someone else’s household', async () => {
    const res = await mint(asRae(recipient.householdId), source.plantId);
    expect(res.statusCode).toBe(404);
    expect(shareRows()).toHaveLength(0);
  });
});

describe('the public preview', () => {
  it('serves the summary with no credential, and only the summary', async () => {
    const { code } = (await mint()).body as { code: string };
    const res = await preview(code);
    expect(res.statusCode).toBe(200);
    const body = res.body as { passport: Record<string, unknown>; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'passport']);
    const json = JSON.stringify(body);
    for (const marker of PRIVATE_MARKERS) expect(json).not.toContain(marker);
    for (const leaked of [
      source.householdId,
      source.plantId,
      source.parentId,
      ADA.userId,
      MEL.userId,
      MEL.name,
      ADA.email,
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it('does not change what the cutting card serves', async () => {
    const { code } = (await mint()).body as { code: string };
    const card = await preview(code, 'card');
    expect(card.statusCode).toBe(200);
    const body = card.body as { plant: Record<string, unknown> };
    expect(Object.keys(body.plant).sort()).toEqual([
      'careRule',
      'imageUrl',
      'name',
      'species',
      'tags',
    ]);
    expect(JSON.stringify(card.body)).not.toContain('"passport"');
  });

  it('is 404 for an unknown code, a malformed code and a plain cutting link', async () => {
    expect((await preview('a'.repeat(32))).statusCode).toBe(404);
    expect((await preview('../../etc/passwd')).statusCode).toBe(404);
    expect((await preview('A'.repeat(32))).statusCode).toBe(404);

    const plants = await plantsHandler();
    const cutting = await invokeHandler(plants, {
      method: 'POST',
      routeKey: 'POST /plants/{id}/share',
      pathParameters: { id: source.plantId },
      identity: asAda(source.householdId),
    });
    const code = (cutting.body as { code: string }).code;
    expect((await preview(code, 'card')).statusCode).toBe(200);
    expect((await preview(code)).statusCode).toBe(404);
  });

  it('stops after 14 days, and a stored block that does not parse reads as no passport', async () => {
    const { code } = (await mint()).body as { code: string };
    const [row] = shareRows();

    // A hand-edited row carrying a private note is refused, not rendered...
    store.put({ ...row, passport: { ...(row.passport as object), notes: PRIVATE.plantNote } });
    expect((await preview(code)).statusCode).toBe(404);
    expect((await importPassport(code)).statusCode).toBe(404);
    // ...while the plain cutting card on the same row still serves.
    expect((await preview(code, 'card')).statusCode).toBe(200);

    // Expired.
    store.put({ ...row, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await preview(code)).statusCode).toBe(404);
    expect((await importPassport(code)).statusCode).toBe(404);
  });
});

describe('importing a passport', () => {
  it('adds ONE plant to the recipient household with its summary as the first note', async () => {
    const { code } = (await mint()).body as { code: string };

    const res = await importPassport(code);

    expect(res.statusCode).toBe(201);
    const plant = res.body as { id: string; householdId: string; notes: string; name: string };
    expect(plant.householdId).toBe(recipient.householdId);
    expect(plant.id).not.toBe(source.plantId);
    expect(plant.name).toBe('Mother Monstera');

    const mine = await plantsOf(recipient.householdId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      species: 'Monstera deliciosa',
      careRule: 'Bottom-water only',
      tags: ['tropical'],
      imageUrl: null,
      parentPlantId: null,
    });
    expect(mine[0].notes).toContain('Plant passport from The Reyes house');
    expect(mine[0].notes).toContain('House rule: Bottom-water only');
    expect(mine[0].notes).toContain('Water every 7 days (winter 14)');
    expect(mine[0].notes).toContain('1 care entry in the last 90 days');
    expect(mine[0].notes).toContain(
      'Lineage: a cutting of Kitchen Pothos; 1 cutting has been taken from it.'
    );
    // A fresh log and the recipient's own schedule: no task came with it.
    const taskService = await import('../../src/services/taskService.js');
    expect(await taskService.getTasks(recipient.householdId)).toHaveLength(0);
  });

  it('gives the recipient none of the household’s private words, people or ids', async () => {
    const { code } = (await mint()).body as { code: string };
    await importPassport(code);

    const recipientRows = JSON.stringify(
      store.all().filter((i) => JSON.stringify(i).includes(recipient.householdId))
    );
    for (const marker of PRIVATE_MARKERS) expect(recipientRows).not.toContain(marker);
    for (const leaked of [source.householdId, source.plantId, MEL.userId, MEL.name, ADA.userId]) {
      expect(recipientRows).not.toContain(leaked);
    }
  });

  it('never touches the source household: its rows are byte-for-byte what they were', async () => {
    const { code } = (await mint()).body as { code: string };
    const snapshot = () =>
      JSON.stringify(
        store
          .all()
          .filter((i) => String(i.PK).includes(source.householdId))
          .sort((a, b) => `${a.PK}|${a.SK}`.localeCompare(`${b.PK}|${b.SK}`))
      );
    const before = snapshot();
    expect((await importPassport(code)).statusCode).toBe(201);
    expect(snapshot()).toBe(before);
  });

  it('keeps its once-per-household marker in the RECIPIENT partition, keyed by digest', async () => {
    const { code } = (await mint()).body as { code: string };
    await importPassport(code);
    const markers = store.all().filter((i) => String(i.SK).startsWith('PASSPORTIMPORT#'));
    expect(markers).toHaveLength(1);
    expect(markers[0].PK).toBe(`HOUSEHOLD#${recipient.householdId}`);
    expect(JSON.stringify(markers[0])).not.toContain(code);
    expect(typeof markers[0].plantId).toBe('string');
    expect(typeof markers[0].ttl).toBe('number');
  });

  it('makes a REPLAY a 409 that names the first copy, and creates nothing', async () => {
    const { code } = (await mint()).body as { code: string };
    const first = await importPassport(code);
    expect(first.statusCode).toBe(201);

    const again = await importPassport(code);
    expect(again.statusCode).toBe(409);
    expect(again.body).toMatchObject({
      details: {
        code: 'PASSPORT_ALREADY_IMPORTED',
        plantId: (first.body as { id: string }).id,
      },
    });
    expect(await plantsOf(recipient.householdId)).toHaveLength(1);
  });

  it('lets a second, different household import the same link once each', async () => {
    const { code } = (await mint()).body as { code: string };
    const otherAdmin = { userId: 'user-other', email: 'other@example.invalid', name: 'Other' };
    const other = await seedHousehold(store, { name: 'Other House', admin: otherAdmin });
    const first = await importPassport(code);
    const second = await importPassport(code, {
      identity: { ...otherAdmin, householdId: other.householdId, householdRole: 'admin' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.body as { householdId: string }).householdId).toBe(other.householdId);
    expect(await plantsOf(recipient.householdId)).toHaveLength(1);
    expect(await plantsOf(other.householdId)).toHaveLength(1);
  });

  it('lets a household import again after it deleted its copy', async () => {
    const { code } = (await mint()).body as { code: string };
    const first = await importPassport(code);
    const plantService = await import('../../src/services/plantService.js');
    await plantService.deletePlant(recipient.householdId, (first.body as { id: string }).id);

    const again = await importPassport(code);
    expect(again.statusCode).toBe(201);
    expect((again.body as { id: string }).id).not.toBe((first.body as { id: string }).id);
  });

  it('refuses a forged household id, plant id, note or summary in the body, and writes nothing', async () => {
    const { code } = (await mint()).body as { code: string };
    const rowsBefore = JSON.stringify(store.all());
    for (const forged of [
      { householdId: source.householdId },
      { householdId: 'hh-victim' },
      { plantId: source.plantId },
      { notes: 'INJECTED' },
      { passport: { version: 1 } },
      { householdId: source.householdId, code },
    ]) {
      const res = await importPassport(code, { body: forged });
      expect(res.statusCode).toBe(400);
    }
    expect(JSON.stringify(store.all())).toBe(rowsBefore);
    expect(await plantsOf(recipient.householdId)).toHaveLength(0);
  });

  it('accepts the empty object and no body', async () => {
    const { code } = (await mint()).body as { code: string };
    expect((await importPassport(code, { body: {} })).statusCode).toBe(201);
    // Second household so this one isn't a replay.
    const otherAdmin = { userId: 'user-other', email: 'other@example.invalid', name: 'Other' };
    const other = await seedHousehold(store, { name: 'Other House', admin: otherAdmin });
    expect(
      (
        await importPassport(code, {
          identity: { ...otherAdmin, householdId: other.householdId, householdRole: 'admin' },
        })
      ).statusCode
    ).toBe(201);
  });

  it('rejects an oversize body with 413 and a malformed one with a 4xx, creating nothing', async () => {
    const { code } = (await mint()).body as { code: string };
    const oversize = await importPassport(code, { body: { padding: 'x'.repeat(4096) } });
    expect(oversize.statusCode).toBe(413);

    const malformed = await invokeHandler(await plantsHandler(), {
      method: 'POST',
      routeKey: 'POST /plants/shared/{code}/passport/import',
      pathParameters: { code },
      identity: asRae(recipient.householdId),
      headers: { 'content-type': 'application/json' },
      body: '{"householdId": ',
    });
    expect(malformed.statusCode).toBeGreaterThanOrEqual(400);
    expect(malformed.statusCode).toBeLessThan(500);
    expect(await plantsOf(recipient.householdId)).toHaveLength(0);
  });

  it('holds the recipient’s plan cap exactly like manual creation, and gives the claim back', async () => {
    const { code } = (await mint()).body as { code: string };
    const plantService = await import('../../src/services/plantService.js');
    const { getEntitledPlan, limitOf } = await import('../../src/models/plans.js');
    const cap = limitOf(getEntitledPlan({ planId: 'seedling' } as never), 'plants') as number;
    const filler: string[] = [];
    for (let i = 0; i < cap; i++) {
      const p = await plantService.createPlant(
        { name: `Filler ${i}` },
        recipient.householdId,
        RAE.userId,
        cap
      );
      filler.push(p.id);
    }

    // The same refusal manual creation gives at the same point.
    await expect(
      plantService.createPlant({ name: 'One more' }, recipient.householdId, RAE.userId, cap)
    ).rejects.toMatchObject({ name: 'PlanLimitError' });
    const res = await importPassport(code);
    expect(res.statusCode).toBe(402);
    expect(await plantsOf(recipient.householdId)).toHaveLength(cap);

    // The claim was given back: room made (archiving frees a slot the way
    // deleting does), and the same link imports.
    await plantService.updatePlant(recipient.householdId, filler[0], { status: 'archived' }, cap);
    const retry = await importPassport(code);
    expect(retry.statusCode).toBe(201);
  });

  it('needs a signed-in member of a household', async () => {
    const { code } = (await mint()).body as { code: string };
    const anonymous = await invokeHandler(await plantsHandler(), {
      method: 'POST',
      routeKey: 'POST /plants/shared/{code}/passport/import',
      pathParameters: { code },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(await plantsOf(recipient.householdId)).toHaveLength(0);
  });

  it('is 404 for a code that names nothing, whatever it looks like', async () => {
    for (const code of ['a'.repeat(32), 'short', '', 'A'.repeat(32), 'z'.repeat(64)]) {
      const res = await importPassport(code);
      expect([400, 404]).toContain(res.statusCode);
    }
    expect(await plantsOf(recipient.householdId)).toHaveLength(0);
  });
});

describe('revoking a passport link', () => {
  it('stops both the preview and the import when the member who made it leaves', async () => {
    const { code } = (await mint(asAda(source.householdId))).body as { code: string };
    // MEL makes one too; ADA (an admin) removes MEL.
    const melLink = (
      await mint({ ...MEL, householdId: source.householdId, householdRole: 'member' as never })
    ).body as { code: string };
    expect((await preview(melLink.code)).statusCode).toBe(200);

    const households = await import('../../src/handlers/households/handler.js');
    const removal = await invokeHandler(households.removeMember, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{householdId}/members/{userId}',
      pathParameters: { householdId: source.householdId, userId: MEL.userId },
      identity: asAda(source.householdId),
    });
    expect(removal.statusCode).toBe(204);

    expect((await preview(melLink.code)).statusCode).toBe(404);
    expect((await importPassport(melLink.code)).statusCode).toBe(404);
    // The link a remaining member made is untouched.
    expect((await preview(code)).statusCode).toBe(200);
  });

  it('stops when the plant is deleted, and answers again if it is restored', async () => {
    const { code } = (await mint()).body as { code: string };
    expect((await preview(code)).statusCode).toBe(200);

    const removed = await invokeHandler(await plantsHandler(), {
      method: 'DELETE',
      routeKey: 'DELETE /plants/{id}',
      pathParameters: { id: source.plantId },
      identity: asAda(source.householdId),
    });
    expect(removed.statusCode).toBeLessThan(300);

    expect((await preview(code)).statusCode).toBe(404);
    expect((await importPassport(code)).statusCode).toBe(404);
    expect(await plantsOf(recipient.householdId)).toHaveLength(0);

    // Restored from the trash inside its own life, the link answers again, WITH
    // its summary: the whole row travelled into the trash and back.
    const households = await import('../../src/handlers/households/handler.js');
    const restored = await invokeHandler(households.handler, {
      method: 'POST',
      routeKey: 'POST /households/{id}/trash/{kind}/{itemId}/restore',
      pathParameters: { id: source.householdId, kind: 'plant', itemId: source.plantId },
      identity: asAda(source.householdId),
    });
    expect(restored.statusCode).toBe(200);
    const again = await preview(code);
    expect(again.statusCode).toBe(200);
    expect(
      (again.body as { passport: { lineage: { parentName: string } } }).passport.lineage.parentName
    ).toBe('Kitchen Pothos');
    expect((await importPassport(code)).statusCode).toBe(201);
  });
});
