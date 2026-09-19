/**
 * Real-handler integration tests for restoring a household from its own
 * export (#669).
 *
 * The round trip is the contract: a seeded household is exported through the
 * REAL `GET /me/export`, the document is imported through the REAL
 * `POST /households/{id}/import-archive` into an empty household, the
 * target is exported again, and every field the export carries is compared.
 * A field is either equal, or on an explicit list of what a restore does not
 * bring back — so a field added to the export later fails here until someone
 * decides which it is.
 *
 * Every address here is `example.invalid`; every string is synthetic.
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
vi.mock('../../src/services/cognitoUsers.js', () => ({
  getUserName: async () => 'Ada Admin',
  getUserEmail: async () => null,
  getUsersByIds: async () => new Map(),
  getHouseholdClaims: async () => ({ householdId: null, role: null }),
  setHouseholdClaims: async () => undefined,
  clearHouseholdClaims: async () => undefined,
  deleteUser: async () => undefined,
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.invalid', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.invalid', name: 'Mel Member' };
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString();
const PRIVATE_NOTE = 'private note: the spare key is under the fern';
const PERENUAL_ID = 4242;

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

type Json = Record<string, unknown>;

interface ExportDoc extends Json {
  households: Array<{
    id: string;
    name: string;
    plants: Json[];
    tasks: Json[];
    manifest?: Json;
  }>;
}

/** Rows that are credentials: a restore must never create or touch one. */
const TOKEN_ROW = /^(SITTER|PLANTTAG|SHARE|KIOSK|CALTOKEN_HASH|APIKEY_HASH|CARETAKER|INVITE)#/;
const tokenRows = () =>
  store
    .all()
    .filter((row) => TOKEN_ROW.test(String(row.PK)))
    .sort((a, b) => String(a.PK).localeCompare(String(b.PK)));

/** Every row that lives in, or indexes into, a household's partitions. */
const rowsOf = (householdId: string) =>
  store
    .all()
    .filter((row) =>
      [row.PK, row.GSI1PK, row.GSI2PK].some(
        (key) => typeof key === 'string' && key.startsWith(`HOUSEHOLD#${householdId}`)
      )
    );

async function exportAs(identity: typeof ADMIN & { householdId: string }): Promise<ExportDoc> {
  const me = await import('../../src/handlers/me/handler.js');
  const res = await invokeHandler(me.exportMe, {
    method: 'GET',
    routeKey: 'GET /me/export',
    identity,
  });
  expect(res.statusCode).toBe(200);
  return res.body as ExportDoc;
}

async function importArchive(
  householdId: string,
  body: unknown,
  who: typeof ADMIN = ADMIN,
  headers?: Record<string, string>
) {
  const households = await import('../../src/handlers/households/handler.js');
  return invokeHandler(households.handler, {
    method: 'POST',
    routeKey: 'POST /households/{id}/import-archive',
    pathParameters: { id: householdId },
    identity: { ...who, householdId },
    body,
    headers,
  });
}

/**
 * A Greenhouse household exercising every field the export carries: all four
 * lifecycle states, a cutting, a catalog-linked species, notes, a house rule,
 * tags, a space, a photo, a seasonal profile, a completion, an assignment to a
 * member who will not be in the target — and every kind of token, so the
 * restore can be shown to carry none of them.
 */
async function buildSource() {
  const plantService = await import('../../src/services/plantService.js');
  const taskService = await import('../../src/services/taskService.js');
  const spaceService = await import('../../src/services/spaceService.js');
  const households = await import('../../src/handlers/households/handler.js');
  const kioskLink = await import('../../src/handlers/households/kioskLink.js');
  const tags = await import('../../src/handlers/plantTags/handler.js');
  const plants = await import('../../src/handlers/plants/handler.js');

  const { householdId } = await seedHousehold(store, {
    name: 'The Old House',
    admin: ADMIN,
    members: [MEMBER],
  });
  await setHouseholdPlan(store, householdId, 'greenhouse');
  // The server's own species cache answers for this catalog id.
  store.put({
    PK: 'PERENUAL#CACHE',
    SK: `SPECIES#${PERENUAL_ID}`,
    entityType: 'PerenualCache',
    payload: { id: PERENUAL_ID, scientificName: 'Monstera deliciosa' },
    cachedAt: new Date().toISOString(),
  });

  const space = await spaceService.createSpace(
    { name: 'Living room', environment: 'inside' },
    householdId,
    ADMIN.userId
  );
  const monstera = await plantService.createPlant(
    {
      name: 'Monstera',
      species: 'Monstera deliciosa',
      location: 'By the sofa',
      spaceId: space.id,
      placementNote: 'east window, top shelf',
      notes: PRIVATE_NOTE,
      careRule: 'bottom-water only',
      tags: ['tropical', 'big leaves'],
      perenualSpeciesId: PERENUAL_ID,
      canonicalSpecies: 'Monstera deliciosa',
      speciesSource: 'catalog',
    },
    householdId,
    ADMIN.userId,
    5000
  );
  const cutting = await plantService.createPlant(
    {
      name: 'Monstera cutting',
      species: 'Monstera deliciosa',
      parentPlantId: monstera.id,
      speciesSource: 'user',
    },
    householdId,
    MEMBER.userId,
    5000
  );
  const fern = await plantService.createPlant({ name: 'Fern' }, householdId, ADMIN.userId, 5000);
  const basil = await plantService.createPlant({ name: 'Basil' }, householdId, ADMIN.userId, 5000);
  const cactus = await plantService.createPlant(
    { name: 'Cactus' },
    householdId,
    ADMIN.userId,
    5000
  );
  await plantService.updatePlant(householdId, fern.id, { status: 'died' }, 5000);
  await plantService.updatePlant(householdId, basil.id, { status: 'archived' }, 5000);
  await plantService.updatePlant(householdId, cactus.id, { status: 'gave_away' }, 5000);
  await plantService.appendPlantPhoto(
    householdId,
    monstera.id,
    `https://cdn.example.invalid/plants/${householdId}/${monstera.id}/leaf.jpg`,
    ADMIN.userId,
    'new leaf'
  );

  const water = await taskService.createTask(
    {
      plantId: monstera.id,
      type: 'water',
      frequency: 7,
      nextDue: inDays(0),
      assignedTo: ADMIN.userId,
      notes: 'use rainwater',
    },
    householdId,
    ADMIN.userId,
    'Monstera'
  );
  await taskService.completeTask(householdId, water.id, ADMIN.userId, ADMIN.name);
  await taskService.createTask(
    { plantId: monstera.id, type: 'fertilize', frequency: 30, assignedTo: MEMBER.userId },
    householdId,
    ADMIN.userId,
    'Monstera'
  );
  await taskService.createTask(
    {
      plantId: cutting.id,
      type: 'custom',
      customType: 'mist',
      frequency: 3,
      seasonalCadences: [
        { season: 'winter', frequency: 7 },
        { season: 'summer', frequency: 2 },
      ],
      nextDue: inDays(2),
    },
    householdId,
    ADMIN.userId,
    'Monstera cutting'
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
    pathParameters: { plantId: monstera.id },
    identity: admin,
  });
  expect(tag.statusCode).toBe(201);
  const share = await invokeHandler(plants.sharePlant, {
    method: 'POST',
    routeKey: 'POST /plants/{id}/share',
    pathParameters: { id: monstera.id },
    identity: admin,
  });
  expect(share.statusCode).toBe(201);

  return {
    householdId,
    monsteraId: monstera.id,
    tokens: {
      sitter: (sitter.body as { token: string }).token,
      kiosk: (kiosk.body as { token: string }).token,
      tag: (tag.body as { token: string }).token,
      share: (share.body as { code: string }).code,
    },
  };
}

/** A new, empty household for ADMIN — "restore into a new one". */
async function newEmptyHousehold(): Promise<string> {
  const householdService = await import('../../src/services/householdService.js');
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  const household = await householdService.createHousehold(
    { name: 'New home' },
    ADMIN.userId,
    ADMIN.name,
    ADMIN.email
  );
  __resetMembershipCacheForTests();
  return household.id;
}

/** Fields a restore deliberately does not carry, and what they become instead. */
const PLANT_NOT_CARRIED = [
  'id', // new, deterministic
  'householdId', // the target
  'createdBy', // the importing admin: the archive's user ids are not members here
  'imageUrl', // the archive holds a link, not the picture
  'spaceId', // spaces are not in the archive
  'summerSpaceId',
  'winterSpaceId',
  'parentPlantId', // remapped onto the new ids — compared by name below
];
const TASK_NOT_CARRIED = [
  'id',
  'householdId',
  'plantId', // remapped — compared through the plant's name
  'createdBy',
  // Kept only for someone who is a member of the target — compared below.
  'assignedTo',
  'assignedToName',
  'assignmentSource',
];

function byName(plants: Json[]): Map<string, Json> {
  return new Map(plants.map((p) => [p.name as string, p]));
}

function taskKey(task: Json): string {
  return `${String(task.plantName)}|${String(task.type)}|${String(task.customType)}`;
}

describe('POST /households/{id}/import-archive — the round trip', () => {
  it('export → empty household → import → export: every carried field is equal', async () => {
    const source = await buildSource();
    const archive = await exportAs({ ...ADMIN, householdId: source.householdId });
    const sourceSection = archive.households.find((h) => h.id === source.householdId)!;
    // Negative controls: the fixture really exercises what is compared below.
    expect(sourceSection.plants).toHaveLength(5);
    expect(sourceSection.tasks).toHaveLength(3);
    expect(JSON.stringify(sourceSection)).toContain(PRIVATE_NOTE);
    expect(sourceSection.plants.some((p) => p.imageUrl)).toBe(true);
    expect(sourceSection.plants.some((p) => p.spaceId)).toBe(true);
    expect(sourceSection.plants.some((p) => p.parentPlantId)).toBe(true);
    // The export is version 2: the section carries its own manifest.
    expect(archive.version).toBe(2);
    expect(sourceSection.manifest).toMatchObject({ counts: { plants: 5, tasks: 3 } });

    const targetId = await newEmptyHousehold();
    const tokensBefore = tokenRows();

    const preview = await importArchive(targetId, {
      mode: 'preview',
      sourceHouseholdId: source.householdId,
      archive,
    });
    expect(preview.statusCode).toBe(200);
    const p = preview.body as Json & {
      digest: string;
      counts: Json;
      notRestored: Json;
      target: Json;
      planLimit: Json;
    };
    expect(p.target).toEqual({ state: 'empty' });
    expect(p.canImport).toBe(true);
    // The manifest was read and every plant and task matched it.
    expect(p).toMatchObject({ source: { version: 2, manifest: 'verified' } });
    expect(p.counts).toEqual({
      plants: 5,
      activePlants: 2,
      pastPlants: 2,
      archivedPlants: 1,
      tasks: 3,
      lineageLinks: 1,
    });
    expect(p.notRestored).toEqual({
      photos: 1,
      spaceAssignments: 1,
      unassignedTasks: 1,
      reinvite: [{ name: 'Mel Member', tasks: 1 }],
      orphanTasks: 0,
      brokenLineage: 0,
      unverifiedSpeciesNames: 0,
    });
    // A preview writes nothing, and never echoes a private note.
    expect(rowsOf(targetId).filter((r) => r.entityType === 'Plant')).toHaveLength(0);
    expect(JSON.stringify(preview.body)).not.toContain(PRIVATE_NOTE);

    const commit = await importArchive(targetId, {
      mode: 'commit',
      sourceHouseholdId: source.householdId,
      confirmDigest: p.digest,
      archive,
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.body).toMatchObject({ status: 'complete', imported: { plants: 5, tasks: 3 } });
    expect(JSON.stringify(commit.body)).not.toContain(PRIVATE_NOTE);

    const after = await exportAs({ ...ADMIN, householdId: targetId });
    const targetSection = after.households.find((h) => h.id === targetId)!;
    expect(targetSection.name).toBe(sourceSection.name);
    expect(targetSection.plants).toHaveLength(sourceSection.plants.length);
    expect(targetSection.tasks).toHaveLength(sourceSection.tasks.length);

    // Plants: the same key set, and every carried field equal.
    const sourcePlants = byName(sourceSection.plants);
    const targetPlants = byName(targetSection.plants);
    const sourceNameById = new Map(sourceSection.plants.map((pl) => [pl.id, pl.name]));
    const targetNameById = new Map(targetSection.plants.map((pl) => [pl.id, pl.name]));
    for (const [name, original] of sourcePlants) {
      const restored = targetPlants.get(name)!;
      expect(restored, name).toBeDefined();
      expect(Object.keys(restored).sort()).toEqual(Object.keys(original).sort());
      for (const key of Object.keys(original)) {
        if (PLANT_NOT_CARRIED.includes(key)) continue;
        expect(restored[key], `${name}.${key}`).toEqual(original[key]);
      }
      expect(restored.id).not.toBe(original.id);
      expect(restored.householdId).toBe(targetId);
      expect(restored.createdBy).toBe(ADMIN.userId);
      expect(restored.imageUrl).toBeNull();
      expect(restored.spaceId).toBeNull();
      // Lineage survives, pointed at the restored parent.
      expect(
        restored.parentPlantId ? targetNameById.get(restored.parentPlantId as string) : null
      ).toBe(original.parentPlantId ? sourceNameById.get(original.parentPlantId as string) : null);
    }

    // Tasks: the same key set, and every carried field equal.
    const sourceTasks = new Map(sourceSection.tasks.map((t) => [taskKey(t), t]));
    const targetTasks = new Map(targetSection.tasks.map((t) => [taskKey(t), t]));
    expect([...targetTasks.keys()].sort()).toEqual([...sourceTasks.keys()].sort());
    for (const [key, original] of sourceTasks) {
      const restored = targetTasks.get(key)!;
      expect(Object.keys(restored).sort()).toEqual(Object.keys(original).sort());
      for (const field of Object.keys(original)) {
        if (TASK_NOT_CARRIED.includes(field)) continue;
        expect(restored[field], `${key}.${field}`).toEqual(original[field]);
      }
      expect(targetNameById.get(restored.plantId as string)).toBe(
        sourceNameById.get(original.plantId as string)
      );
      // An assignment survives only for a member of the target household.
      if (original.assignedTo === ADMIN.userId) {
        expect(restored.assignedTo).toBe(ADMIN.userId);
        expect(restored.assignedToName).toBe(ADMIN.name);
      } else {
        expect(restored.assignedTo).toBeNull();
        expect(restored.assignedToName).toBeNull();
      }
    }

    // The plan cap's counter counts exactly the restored active plants.
    const meta = store.all().find((r) => r.PK === `HOUSEHOLD#${targetId}` && r.SK === 'METADATA');
    expect(meta?.plantCount).toBe(2);
    expect(meta?.archiveImportStatus).toBe('complete');

    // No credential of any kind was created, and none moved.
    expect(tokenRows()).toEqual(tokensBefore);
    const targetRows = JSON.stringify(rowsOf(targetId));
    for (const token of Object.values(source.tokens)) {
      expect(targetRows).not.toContain(token);
    }
    const allowed = ['Household', 'HouseholdMember', 'Plant', 'Task', 'ActivityEvent'];
    for (const row of rowsOf(targetId)) {
      expect(allowed, `${String(row.PK)} ${String(row.SK)}`).toContain(row.entityType);
    }
  });

  it('adds nothing when the same archive is committed again', async () => {
    const source = await buildSource();
    const archive = await exportAs({ ...ADMIN, householdId: source.householdId });
    const targetId = await newEmptyHousehold();
    const body = { sourceHouseholdId: source.householdId, archive };
    const preview = await importArchive(targetId, { mode: 'preview', ...body });
    const digest = (preview.body as { digest: string }).digest;
    const first = await importArchive(targetId, { mode: 'commit', confirmDigest: digest, ...body });
    expect(first.statusCode).toBe(200);
    const rowsAfterFirst = JSON.stringify(rowsOf(targetId));

    const again = await importArchive(targetId, { mode: 'commit', confirmDigest: digest, ...body });
    expect(again.statusCode).toBe(200);
    expect(again.body).toMatchObject({
      status: 'already_imported',
      imported: { plants: 0, tasks: 0 },
    });
    expect(JSON.stringify(rowsOf(targetId))).toBe(rowsAfterFirst);

    const previewAgain = await importArchive(targetId, { mode: 'preview', ...body });
    expect(previewAgain.body).toMatchObject({
      target: { state: 'already_imported' },
      canImport: false,
    });
  });
});

/** A hand-built version-1 archive of `n` active plants, one task each. */
function syntheticArchive(n: number, extra: Json = {}): ExportDoc {
  const createdAt = '2026-01-01T00:00:00.000Z';
  return {
    format: 'family-greenhouse-export',
    version: 1,
    exportedAt: '2026-09-01T00:00:00.000Z',
    households: [
      {
        id: 'source-household',
        name: 'Synthetic',
        plants: Array.from({ length: n }, (_, i) => ({
          id: `plant-${i}`,
          name: `Plant ${i}`,
          status: 'active',
          tags: [],
          createdAt,
          updatedAt: createdAt,
        })),
        tasks: Array.from({ length: n }, (_, i) => ({
          id: `task-${i}`,
          plantId: `plant-${i}`,
          type: 'water',
          frequency: 7,
          nextDue: '2026-09-20T00:00:00.000Z',
          createdAt,
        })),
      },
    ],
    ...extra,
  };
}

async function previewThenCommit(targetId: string, archive: unknown) {
  const preview = await importArchive(targetId, { mode: 'preview', archive });
  const digest = (preview.body as { digest?: string }).digest;
  const commit = await importArchive(targetId, { mode: 'commit', confirmDigest: digest, archive });
  return { preview, commit };
}

describe('POST /households/{id}/import-archive — refusals, before any write', () => {
  it('refuses a newer or unknown version with a message naming it, and writes nothing', async () => {
    const targetId = await newEmptyHousehold();
    const snapshot = JSON.stringify(store.all());

    const newer = await importArchive(targetId, {
      mode: 'preview',
      archive: { ...syntheticArchive(1), version: 3 },
    });
    expect(newer.statusCode).toBe(400);
    expect(newer.body).toMatchObject({
      message: expect.stringContaining('newer version'),
      details: { code: 'unsupported_version', version: 3, supported: 2 },
    });
    const unknown = await importArchive(targetId, {
      mode: 'commit',
      confirmDigest: '0'.repeat(64),
      archive: { ...syntheticArchive(1), version: 'one' },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toMatchObject({ details: { code: 'unsupported_version' } });
    const otherApp = await importArchive(targetId, {
      mode: 'preview',
      archive: { ...syntheticArchive(1), format: 'planta-backup' },
    });
    expect(otherApp.body).toMatchObject({ details: { code: 'unknown_format' } });
    expect(JSON.stringify(store.all())).toBe(snapshot);

    // Negative control: the same archive at version 1 is accepted, so the
    // refusals above are about the version and the format, nothing else.
    const ok = await importArchive(targetId, { mode: 'preview', archive: syntheticArchive(1) });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses prototype-pollution keys at the parser and again at the archive guard', async () => {
    const targetId = await newEmptyHousehold();
    const plant = '{"id":"p1","name":"Fern","createdAt":"2026-01-01T00:00:00.000Z"';
    const wrap = (plantJson: string) =>
      `{"mode":"preview","archive":{"format":"family-greenhouse-export","version":1,"households":[{"id":"h1","name":"Home","plants":[${plantJson}],"tasks":[]}]}}`;
    const proto = wrap(`${plant},"__proto__":{"polluted":true}}`);
    const prototypeKey = wrap(`${plant},"prototype":{"polluted":true}}`);
    // Negative control: the payloads really carry the keys as own properties.
    const parsed = JSON.parse(proto) as {
      archive: { households: Array<{ plants: Json[] }> };
    };
    expect(Object.keys(parsed.archive.households[0].plants[0])).toContain('__proto__');
    expect(prototypeKey).toContain('"prototype"');

    // As JSON, the body parser refuses `__proto__` itself.
    const asJson = await importArchive(targetId, proto);
    expect(asJson.statusCode).toBe(422);
    // Mislabelled as text, the body reaches the handler unparsed — the
    // archive guard is then the one that refuses it.
    const asText = await importArchive(targetId, proto, ADMIN, { 'content-type': 'text/plain' });
    expect(asText.statusCode).toBe(400);
    expect(asText.body).toMatchObject({ details: { code: 'unsafe_content' } });
    // `prototype` passes the body parser; the archive guard refuses it.
    const proto2 = await importArchive(targetId, prototypeKey);
    expect(proto2.statusCode).toBe(400);
    expect(proto2.body).toMatchObject({ details: { code: 'unsafe_content' } });
    expect(({} as Json).polluted).toBeUndefined();
  });

  it('refuses a body over 5 MiB unparsed', async () => {
    const { ARCHIVE_MAX_BYTES } = await import('../../src/models/householdArchive.js');
    const targetId = await newEmptyHousehold();
    const archive = syntheticArchive(1);
    archive.padding = 'x'.repeat(ARCHIVE_MAX_BYTES);
    const body = JSON.stringify({ mode: 'preview', archive });
    expect(Buffer.byteLength(body)).toBeGreaterThan(ARCHIVE_MAX_BYTES);
    const res = await importArchive(targetId, body);
    expect(res.statusCode).toBe(413);
  });

  it('is admin-only', async () => {
    const householdService = await import('../../src/services/householdService.js');
    const targetId = await newEmptyHousehold();
    await householdService.addMember(targetId, MEMBER.userId, MEMBER.name, MEMBER.email, 10);
    const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const res = await importArchive(
      targetId,
      { mode: 'preview', archive: syntheticArchive(1) },
      MEMBER
    );
    expect(res.statusCode).toBe(403);
    // Negative control: the admin of the same household is let in.
    const admin = await importArchive(targetId, { mode: 'preview', archive: syntheticArchive(1) });
    expect(admin.statusCode).toBe(200);
  });

  it('never merges into a household that already has data', async () => {
    const source = await buildSource();
    const archive = await exportAs({ ...ADMIN, householdId: source.householdId });
    const before = JSON.stringify(rowsOf(source.householdId));
    const { preview, commit } = await previewThenCommit(source.householdId, archive);
    expect(preview.body).toMatchObject({ target: { state: 'not_empty' }, canImport: false });
    expect(commit.statusCode).toBe(409);
    expect(commit.body).toMatchObject({ details: { code: 'not_empty' } });
    expect(JSON.stringify(rowsOf(source.householdId))).toBe(before);
  });

  it('refuses a commit whose archive is not the one previewed', async () => {
    const targetId = await newEmptyHousehold();
    const preview = await importArchive(targetId, {
      mode: 'preview',
      archive: syntheticArchive(2),
    });
    const digest = (preview.body as { digest: string }).digest;
    const edited = syntheticArchive(3);
    const res = await importArchive(targetId, {
      mode: 'commit',
      confirmDigest: digest,
      archive: edited,
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ details: { code: 'archive_changed' } });
    expect(rowsOf(targetId).filter((r) => r.entityType === 'Plant')).toHaveLength(0);
  });

  it('refuses an archive over the plan cap with a clear message, restoring none of it', async () => {
    const { limitOf, PLANS } = await import('../../src/models/plans.js');
    const cap = limitOf(PLANS.seedling, 'plants') as number;
    const targetId = await newEmptyHousehold();
    await setHouseholdPlan(store, targetId, 'seedling');

    const over = await previewThenCommit(targetId, syntheticArchive(cap + 1));
    expect(over.preview.body).toMatchObject({
      planLimit: { limit: cap, currentActivePlants: 0, fits: false },
      canImport: false,
    });
    expect(over.commit.statusCode).toBe(402);
    expect(over.commit.body).toMatchObject({
      message: expect.stringContaining(`limited to ${cap} plants. Nothing was restored.`),
      details: { code: 'over_plan_limit', limit: cap, activePlants: cap + 1 },
    });
    expect(rowsOf(targetId).filter((r) => r.entityType === 'Plant')).toHaveLength(0);

    // Negative control: exactly at the cap, it restores.
    const at = await previewThenCommit(targetId, syntheticArchive(cap));
    expect(at.commit.statusCode).toBe(200);
    expect(rowsOf(targetId).filter((r) => r.entityType === 'Plant')).toHaveLength(cap);
  });
});

describe('POST /households/{id}/import-archive — format versions (#669)', () => {
  /** An export written by the app as it was released: version 1, no manifest. */
  const releasedExport = (): ExportDoc =>
    JSON.parse(
      readFileSync(new URL('../fixtures/household-export-v1.json', import.meta.url), 'utf8')
    ) as ExportDoc;

  it('still restores an export the released app wrote (version 1, no manifest)', async () => {
    const archive = releasedExport();
    // The fixture really is the old shape: version 1, and nothing like a manifest.
    expect(archive.version).toBe(1);
    expect(archive.households[0].manifest).toBeUndefined();
    expect(JSON.stringify(archive)).not.toContain('manifest');
    expect(archive.households[0].plants).toHaveLength(5);

    const targetId = await newEmptyHousehold();
    const { preview, commit } = await previewThenCommit(targetId, archive);
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toMatchObject({
      // No manifest to check, and the preview says so instead of implying a check.
      source: { version: 1, manifest: 'absent', name: 'The Old House' },
      counts: { plants: 5, activePlants: 2, pastPlants: 2, archivedPlants: 1, tasks: 3 },
      canImport: true,
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.body).toMatchObject({ status: 'complete', imported: { plants: 5, tasks: 3 } });

    // The restored household exports as version 2 with a manifest that verifies:
    // an old file goes in, a current one comes out.
    const after = await exportAs({ ...ADMIN, householdId: targetId });
    expect(after.version).toBe(2);
    expect(after.households.find((h) => h.id === targetId)?.plants).toHaveLength(5);
    const again = await importArchive(await newEmptyHousehold(), {
      mode: 'preview',
      sourceHouseholdId: targetId,
      archive: after,
    });
    expect(again.body).toMatchObject({ source: { version: 2, manifest: 'verified' } });
  });

  it('restores the same plants from a version 1 file and from its version 2 successor', async () => {
    const old = releasedExport();
    const successor: ExportDoc = JSON.parse(JSON.stringify(old));
    successor.version = 2;
    const { buildArchiveManifest } = await import('../../src/models/householdArchive.js');
    const section = successor.households[0];
    section.manifest = buildArchiveManifest(section.plants, section.tasks) as unknown as Json;

    const first = await previewThenCommit(await newEmptyHousehold(), old);
    const second = await previewThenCommit(await newEmptyHousehold(), successor);
    expect(first.commit.statusCode).toBe(200);
    expect(second.commit.statusCode).toBe(200);
    // Same rows, told apart only by what was checked.
    expect(second.preview.body).toMatchObject({ source: { version: 2, manifest: 'verified' } });
    expect((second.preview.body as Json).counts).toEqual((first.preview.body as Json).counts);
    expect((second.commit.body as Json).imported).toEqual((first.commit.body as Json).imported);
  });

  it('refuses a version 2 export that does not match its manifest, before any write', async () => {
    const source = await buildSource();
    const archive = await exportAs({ ...ADMIN, householdId: source.householdId });
    const pristine = JSON.stringify(archive);
    const targetId = await newEmptyHousehold();
    const snapshot = JSON.stringify(store.all());

    const tamper = (change: (section: ExportDoc['households'][number]) => void): ExportDoc => {
      const doc = JSON.parse(pristine) as ExportDoc;
      change(doc.households.find((h) => h.id === source.householdId)!);
      // The manifest is left exactly as the export wrote it.
      expect(JSON.stringify(doc.households[0].manifest)).toBe(
        JSON.stringify(JSON.parse(pristine).households[0].manifest)
      );
      return doc;
    };
    const cases: Array<[string, ExportDoc]> = [
      ['a plant cut out', tamper((s) => s.plants.pop())],
      ['a task cut out', tamper((s) => s.tasks.shift())],
      [
        'a plant swapped for another (the count still matches)',
        tamper((s) => {
          s.plants.pop();
          s.plants.push({ ...s.plants[0], id: 'a-different-plant', name: 'Swapped in' });
        }),
      ],
      [
        'a note edited',
        tamper((s) => {
          s.plants[0].notes = 'edited by hand';
        }),
      ],
      [
        'a cadence edited',
        tamper((s) => {
          s.tasks[0].frequency = 99;
        }),
      ],
    ];
    for (const [label, doc] of cases) {
      // Negative control: the edit really is in the file the server is sent.
      expect(JSON.stringify(doc), label).not.toBe(pristine);
      for (const mode of ['preview', 'commit'] as const) {
        const res = await importArchive(targetId, {
          mode,
          sourceHouseholdId: source.householdId,
          confirmDigest: '0'.repeat(64),
          archive: doc,
        });
        expect(res.statusCode, `${label} (${mode})`).toBe(400);
        expect(res.body, `${label} (${mode})`).toMatchObject({
          details: { code: 'manifest_mismatch' },
        });
        // Counts only: no name, note or id from the file rides in the refusal.
        expect(JSON.stringify(res.body)).not.toContain(PRIVATE_NOTE);
        expect(JSON.stringify(res.body)).not.toContain('Swapped in');
      }
    }
    // Nothing was written by any of them.
    expect(JSON.stringify(store.all())).toBe(snapshot);

    // Control: the untouched export restores through the same route.
    const ok = await previewThenCommit(targetId, JSON.parse(pristine));
    expect(ok.commit.statusCode).toBe(200);
  });

  it('refuses a version 2 export with no manifest at all', async () => {
    const source = await buildSource();
    const archive = await exportAs({ ...ADMIN, householdId: source.householdId });
    delete archive.households[0].manifest;
    expect(archive.version).toBe(2);
    const targetId = await newEmptyHousehold();
    const snapshot = JSON.stringify(store.all());
    const res = await importArchive(targetId, { mode: 'preview', archive });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      details: { code: 'invalid_content', path: 'households.0.manifest' },
    });
    expect(JSON.stringify(store.all())).toBe(snapshot);
  });

  it('writes the manifest as counts and digests only', async () => {
    const source = await buildSource();
    const archive = await exportAs({ ...ADMIN, householdId: source.householdId });
    const manifest = archive.households[0].manifest as {
      counts: Json;
      plantDigests: string[];
      taskDigests: string[];
    };
    expect(manifest.counts).toEqual({ plants: 5, tasks: 3 });
    expect(manifest.plantDigests).toHaveLength(5);
    expect(manifest.taskDigests).toHaveLength(3);
    const text = JSON.stringify(manifest);
    // Not a note, a name, a token, an id or a Stripe reference: hex digests.
    expect(text).not.toContain(PRIVATE_NOTE);
    expect(text).not.toContain('Monstera');
    for (const token of Object.values(source.tokens)) expect(text).not.toContain(token);
    expect(text).not.toMatch(/cus_|sub_|price_|pi_/);
    for (const digest of [...manifest.plantDigests, ...manifest.taskDigests]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('POST /households/{id}/import-archive — untrusted content', () => {
  it('drops smuggled tokens and hashes: none becomes a row, and no working link appears', async () => {
    const source = await buildSource();
    const archive = await exportAs({ ...ADMIN, householdId: source.householdId });
    const section = archive.households.find((h) => h.id === source.householdId)!;
    // Real hashes from the source's own token rows (#811), plus the raw tokens.
    const hashes = tokenRows().map((row) => String(row.PK).split('#')[1]);
    expect(hashes.length).toBeGreaterThanOrEqual(4);
    Object.assign(section.plants[0], {
      tagTokenHash: hashes[0],
      shareCode: source.tokens.share,
      tagToken: source.tokens.tag,
    });
    Object.assign(section as Json, {
      sitterLinks: [{ token: source.tokens.sitter, tokenHash: hashes[1] }],
      kioskLink: { token: source.tokens.kiosk },
    });
    // Negative control: the sabotage landed in what is uploaded.
    const uploaded = JSON.stringify(archive);
    for (const value of [...hashes.slice(0, 2), ...Object.values(source.tokens)]) {
      expect(uploaded).toContain(value);
    }

    const targetId = await newEmptyHousehold();
    const before = tokenRows();
    const { commit } = await previewThenCommit(targetId, {
      ...archive,
      households: [section],
    });
    expect(commit.statusCode).toBe(200);

    expect(tokenRows()).toEqual(before);
    const stored = JSON.stringify(rowsOf(targetId));
    for (const value of [...hashes, ...Object.values(source.tokens)]) {
      expect(stored).not.toContain(value);
    }
    // The source's tag still resolves to the SOURCE plant, and only there.
    const tags = await import('../../src/handlers/plantTags/handler.js');
    const view = await invokeHandler(tags.getTagView, {
      method: 'GET',
      routeKey: 'GET /tag/{token}',
      pathParameters: { token: source.tokens.tag },
    });
    expect(view.statusCode).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain(targetId);
  });

  it('never trusts a file-supplied canonical name, provenance, photo URL or lineage loop', async () => {
    const archive = syntheticArchive(0);
    const createdAt = '2026-01-01T00:00:00.000Z';
    archive.households[0].plants = [
      {
        id: 'a',
        name: 'Loop A',
        parentPlantId: 'b',
        createdAt,
        canonicalSpecies: 'Forged scientificus',
        species: 'Something typed',
        speciesSource: 'catalog', // no catalog id: a typed name cannot claim it
        imageUrl: '../../../../etc/passwd',
      },
      { id: 'b', name: 'Loop B', parentPlantId: 'a', createdAt },
      { id: 'c', name: 'Orphan cutting', parentPlantId: 'not-in-archive', createdAt },
      {
        id: 'd',
        name: 'Uncached',
        perenualSpeciesId: 999,
        species: 'Ficus',
        speciesSource: 'catalog',
        createdAt,
      },
    ];
    archive.households[0].tasks = [
      { id: 't', plantId: 'gone', type: 'water', frequency: 7, nextDue: createdAt, createdAt },
    ];
    const targetId = await newEmptyHousehold();
    const { preview, commit } = await previewThenCommit(targetId, archive);
    expect(preview.body).toMatchObject({
      notRestored: { brokenLineage: 2, orphanTasks: 1, photos: 1, unverifiedSpeciesNames: 1 },
    });
    expect(commit.statusCode).toBe(200);

    const plants = rowsOf(targetId).filter((r) => r.entityType === 'Plant');
    const named = (name: string) => plants.find((r) => r.name === name)!;
    expect(named('Loop A').canonicalSpecies).toBeNull();
    expect(named('Loop A').speciesSource).toBeNull();
    expect(named('Loop A').imageUrl).toBeNull();
    expect(named('Uncached').canonicalSpecies).toBeNull();
    expect(named('Uncached').speciesSource).toBe('catalog');
    expect(named('Orphan cutting').parentPlantId).toBeNull();
    // The loop is broken: following parents from either end terminates.
    const byId = new Map(plants.map((r) => [r.id, r]));
    for (const start of [named('Loop A'), named('Loop B')]) {
      const seen = new Set<unknown>();
      let current: Json | undefined = start;
      while (current && current.parentPlantId) {
        expect(seen.has(current.id)).toBe(false);
        seen.add(current.id);
        current = byId.get(current.parentPlantId);
      }
    }
    expect(rowsOf(targetId).filter((r) => r.entityType === 'Task')).toHaveLength(0);
  });
});

describe('POST /households/{id}/import-archive — an interrupted restore', () => {
  it('reports exactly what landed, and the same archive finishes it without duplicates', async () => {
    const targetId = await newEmptyHousehold();
    await setHouseholdPlan(store, targetId, 'greenhouse');
    const archive = syntheticArchive(120);

    // Sabotage: the SECOND transaction fails outright (not a condition).
    const realSend = store.client.send;
    let transactions = 0;
    let sabotaged = 0;
    store.client.send = async (command) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        transactions += 1;
        if (transactions === 2) {
          sabotaged += 1;
          throw Object.assign(new Error('Service unavailable'), { name: 'InternalServerError' });
        }
      }
      return realSend(command);
    };
    let first;
    try {
      first = await previewThenCommit(targetId, archive);
    } finally {
      store.client.send = realSend;
    }
    // Negative control: the sabotage really fired.
    expect(sabotaged).toBe(1);
    expect(first.commit.statusCode).toBe(503);
    expect(first.commit.body).toMatchObject({
      details: {
        code: 'interrupted',
        landed: { plants: 49, tasks: 0 },
        expected: { plants: 120, tasks: 120 },
      },
    });
    const plantRows = () => rowsOf(targetId).filter((r) => r.entityType === 'Plant');
    expect(plantRows()).toHaveLength(49);
    const meta = () =>
      store.all().find((r) => r.PK === `HOUSEHOLD#${targetId}` && r.SK === 'METADATA');
    expect(meta()?.plantCount).toBe(49);
    expect(meta()?.archiveImportStatus).toBe('in_progress');

    const resumed = await previewThenCommit(targetId, archive);
    expect(resumed.preview.body).toMatchObject({ target: { state: 'resumable' }, canImport: true });
    expect(resumed.commit.statusCode).toBe(200);
    expect(resumed.commit.body).toMatchObject({
      status: 'complete',
      imported: { plants: 120, tasks: 120 },
    });
    expect(plantRows()).toHaveLength(120);
    expect(rowsOf(targetId).filter((r) => r.entityType === 'Task')).toHaveLength(120);
    expect(meta()?.plantCount).toBe(120);
    expect(meta()?.archiveImportStatus).toBe('complete');
  });
});
