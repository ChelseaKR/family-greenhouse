/**
 * A printed plant tag must not show more than a sitter link does.
 *
 * #709 (#732) stopped the sitter brief, which goes to a person the household
 * chose for a window that expires, from returning a plant's free-text `notes`.
 * The public `GET /tag/{token}` scan kept returning them to anyone who can see
 * the label, and the household PIN is off by default. The less trusted reader
 * saw more. The scan now carries the house rule through the same resolver the
 * brief uses (`models/sitterBriefFields.ts`), and this file keeps it that way.
 *
 * It measures the REAL responses of both surfaces, built through the real
 * handlers, rather than a list of field names typed here:
 *
 *   1. SHAPE. Every leaf field of the scan response must also be a field of
 *      the sitter brief's entry for the same plant, or be one of the
 *      `TAG_ONLY` fields, which the PIN-off notice has to name in both
 *      locales. A field added to the scan and not to the brief fails here
 *      unless the notice is changed to disclose it.
 *   2. VALUES. A field the two share must carry the same datum, so a field
 *      cannot pass on its name alone (`careNote: plant.notes` would).
 *   3. BYTES. Every distinctive token in the scan outside `TAG_ONLY` (each
 *      synthetic marker planted below, every id, every timestamp) must also
 *      appear somewhere in what the sitter link returns.
 *
 * The seed fills every field of the scan so no sub-shape can hide behind a
 * null, and the test checks that it did. Every string planted here is
 * synthetic.
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
// Only the AWS boundary is faked, exactly as in sitter-privacy.test.ts.
vi.mock('../../src/utils/s3.js', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/s3.js')>();
  return {
    ...actual,
    signedImageUrl: async (key: string, ttl: number) => `https://signed.example/${key}?ttl=${ttl}`,
  };
});
vi.mock('../../src/services/cognitoUsers.js', () => ({
  getUserName: async () => 'ADMINFIRST-2P5 ADMINLAST-8J3',
  getUserEmail: async () => null,
  getUsersByIds: async () => new Map(),
}));

const ADMIN = {
  userId: 'user-admin',
  email: 'fixture-admin-contact',
  name: 'ADMINFIRST-2P5 ADMINLAST-8J3',
};
const MEMBER = {
  userId: 'user-member',
  email: 'fixture-member-contact',
  name: 'MELFIRST-4R7 MEMBERLAST-6T2',
};

const PLANT_NAME = 'PLANTNAME-IOTA';
// Deliberately not a plant the curated pet-toxicity table knows, so the brief
// cannot echo the species back through `petSafety.matchedOn` and make this
// test pass on a coincidence.
const SPECIES = 'SPECIESNAME-2W6 fixturea';
const PLANT_PRIVATE_NOTE = 'PRIVATENOTE-7Q2 household free text';
const HOUSE_RULE = 'CARERULE-5K1 bottom-water only';
const PLACEMENT_NOTE = 'PLACEMENT-3X9 east window';
const SPACE_NAME = 'SPACENAME-THETA';
const TASK_PRIVATE_NOTE = 'TASKNOTE-8M4 private task note';
const SIBLING_NAME = 'PLANTNAME-KAPPA';
const SIBLING_NOTE = 'PRIVATENOTE-9Z8 sibling free text';
const HOUSEHOLD_CITY = 'HHCITY-EPSILON';
const HOUSEHOLD_NAME = 'HHNAME-OMICRON';

/**
 * What a scan shows that a sitter link does not, and why each one stays.
 *
 * - `species`: the label sits on one pot, and saying what the plant is comes
 *   first on the scan page. The sitter brief has never carried it.
 * - `history`: "last watered Tuesday by Dad" is the line the feature exists
 *   for (ADR 0016). It is also the one thing here a sitter link promises NOT
 *   to carry (member identity), which is why it has to be disclosed on the
 *   page where the household decides whether to set a PIN.
 *
 * Each entry names the phrase the PIN-off notice must contain in each locale.
 * Adding an entry without disclosing it in the notice fails the copy check.
 */
const TAG_ONLY = {
  species: { en: 'species', es: 'especie' },
  history: { en: 'first name only', es: 'solo el nombre de pila' },
} as const;

/**
 * The scan and the brief name two shared fields differently. Each rename says
 * how the two values are shown to be the SAME datum, so this map cannot be
 * used to pass an unrelated field under a borrowed name.
 */
const RENAMED: Record<
  string,
  { briefField: string; sameDatum: (tag: unknown, brief: unknown) => boolean }
> = {
  plantName: { briefField: 'name', sameDatum: (tag, brief) => tag === brief },
  // The brief hands out a short-lived signed address for the photo; the scan
  // hands out the stored one. Same object either way.
  imageUrl: {
    briefField: 'photoUrl',
    sameDatum: (tag, brief) =>
      typeof tag === 'string' &&
      typeof brief === 'string' &&
      new URL(tag).pathname === new URL(brief).pathname,
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString();

const ROOT = new URL('../../../', import.meta.url);
function catalog(tag: 'en' | 'es', file: 'translation' | 'legal'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`frontend/src/i18n/locales/${tag}/${file}.json`, ROOT), 'utf8')
  ) as Record<string, unknown>;
}
const pinOffNotice = (tag: 'en' | 'es'): string =>
  (catalog(tag, 'translation') as { plantTags: { pinOffNotice: string } }).plantTags.pinOffNotice;
const sharingSentence = (tag: 'en' | 'es'): string =>
  (catalog(tag, 'legal') as { legal: { privacy: { thirdParties: { noSale: string } } } }).legal
    .privacy.thirdParties.noSale;

/** Every leaf field as a dotted path, arrays collapsed to `[]`. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => leafPaths(item, `${prefix}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      leafPaths(child, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [prefix];
}
const uniq = (items: string[]) => [...new Set(items)].sort();

function nullLeaves(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [prefix];
  if (Array.isArray(value)) {
    return value.length === 0
      ? [`${prefix}[] (empty)`]
      : value.flatMap((item) => nullLeaves(item, `${prefix}[]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      nullLeaves(child, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [];
}

/** Synthetic markers, UUIDs and ISO timestamps: tokens that identify a datum. */
const DISTINCTIVE =
  /[A-Z]{4,}-[0-9A-Z]{3}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

interface Seeded {
  householdId: string;
  plantId: string;
  sitterToken: string;
  tagToken: string;
}

/**
 * One household where every field either surface could return is filled: a
 * named space, a plant with a species, a private note, a placement note, a
 * house rule and a photo, a sibling plant with its own private note, a due task
 * carrying a private task note, a watering a member logged (so the scan's
 * "last watered by" is populated), a sitter link, and a tag, both minted by a
 * plain member through the real handlers.
 */
async function seedEverything(): Promise<Seeded> {
  const householdsHandler = await import('../../src/handlers/households/handler.js');
  const tagsHandler = await import('../../src/handlers/plantTags/handler.js');
  const plantService = await import('../../src/services/plantService.js');
  const spaceService = await import('../../src/services/spaceService.js');
  const taskService = await import('../../src/services/taskService.js');
  const householdService = await import('../../src/services/householdService.js');

  const { householdId } = await seedHousehold(store, {
    name: HOUSEHOLD_NAME,
    admin: ADMIN,
    members: [MEMBER],
  });
  // Greenhouse: tags, the brief and its photo are all on, so both surfaces are
  // measured at their widest.
  await setHouseholdPlan(store, householdId, 'greenhouse');
  await householdService.setHouseholdLocation(householdId, {
    city: HOUSEHOLD_CITY,
    latitude: 34.05,
    longitude: -118.24,
  });
  const space = await spaceService.createSpace({ name: SPACE_NAME }, householdId, ADMIN.userId);

  const plant = await plantService.createPlant(
    {
      name: PLANT_NAME,
      species: SPECIES,
      notes: PLANT_PRIVATE_NOTE,
      placementNote: PLACEMENT_NOTE,
      careRule: HOUSE_RULE,
    },
    householdId,
    ADMIN.userId,
    5000
  );
  await plantService.updatePlant(householdId, plant.id, { spaceId: space.id }, 5000);
  const row = store.all().find((i) => i.SK === `PLANT#${plant.id}`);
  expect(row, 'the seeded plant row must exist before its photo is attached').toBeTruthy();
  store.put({
    ...row,
    imageUrl: `https://cdn.fixture.invalid/plants/${householdId}/${plant.id}/pic1.jpg`,
  });

  await plantService.createPlant(
    { name: SIBLING_NAME, notes: SIBLING_NOTE },
    householdId,
    ADMIN.userId,
    5000
  );

  // A due task that stays due (so the scan's `tasks` is not empty) ...
  await taskService.createTask(
    {
      plantId: plant.id,
      type: 'fertilize',
      frequency: 30,
      nextDue: inDays(1),
      notes: TASK_PRIVATE_NOTE,
    },
    householdId,
    ADMIN.userId,
    PLANT_NAME
  );
  // ... and a watering a member already logged (so `history` is not empty).
  const water = await taskService.createTask(
    { plantId: plant.id, type: 'water', frequency: 7, nextDue: inDays(0) },
    householdId,
    ADMIN.userId,
    PLANT_NAME
  );
  await taskService.completeTask(householdId, water.id, MEMBER.userId, MEMBER.name);

  const link = await invokeHandler(householdsHandler.createSitterLink, {
    method: 'POST',
    routeKey: 'POST /households/{id}/sitter-links',
    pathParameters: { id: householdId },
    identity: { ...MEMBER, householdId },
    body: { expiresAt: inDays(14), label: 'Trip' },
  });
  expect(link.statusCode).toBe(201);

  const tag = await invokeHandler(tagsHandler.issuePlantTag, {
    method: 'POST',
    routeKey: 'POST /plants/{plantId}/tag',
    pathParameters: { plantId: plant.id },
    identity: { ...MEMBER, householdId },
  });
  expect(tag.statusCode).toBe(201);

  return {
    householdId,
    plantId: plant.id,
    sitterToken: (link.body as { token: string }).token,
    tagToken: (tag.body as { token: string }).token,
  };
}

/** The public tag scan and both public sitter reads, with no credential but the token. */
async function readBothSurfaces(seeded: Seeded) {
  const tagsHandler = await import('../../src/handlers/plantTags/handler.js');
  const tasksHandler = await import('../../src/handlers/tasks/handler.js');

  const scan = await invokeHandler(tagsHandler.getTagView, {
    method: 'GET',
    routeKey: 'GET /tag/{token}',
    pathParameters: { token: seeded.tagToken },
  });
  const view = await invokeHandler(tasksHandler.getSitterView, {
    method: 'GET',
    routeKey: 'GET /sitter/{token}',
    pathParameters: { token: seeded.sitterToken },
  });
  const brief = await invokeHandler(tasksHandler.getSitterBrief, {
    method: 'GET',
    routeKey: 'GET /sitter/{token}/brief',
    pathParameters: { token: seeded.sitterToken },
  });
  expect(scan.statusCode).toBe(200);
  expect(view.statusCode).toBe(200);
  expect(brief.statusCode).toBe(200);

  const tagBody = scan.body as Record<string, unknown>;
  const briefEntry = (brief.body as { plants: Array<Record<string, unknown>> }).plants.find(
    (p) => p.plantId === seeded.plantId
  );
  expect(briefEntry, 'the brief must list the tagged plant').toBeTruthy();

  return {
    tagBody,
    tagWire: JSON.stringify(tagBody),
    briefEntry: briefEntry!,
    sitterWire: JSON.stringify({ view: view.body, brief: brief.body }),
  };
}

function getPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value
    );
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

describe('the copy says what a tag scan shows', () => {
  // The notice is shown on the tags page exactly when no PIN is set, which is
  // the default. It has to name every TAG_ONLY field, say Notes are not shown,
  // and say a PIN restricts the scan, in both locales.
  it.each(['en', 'es'] as const)('%s PIN-off notice names every tag-only field', (tag) => {
    for (const [field, phrase] of Object.entries(TAG_ONLY)) {
      expect(pinOffNotice(tag), `the notice must disclose \`${field}\``).toContain(phrase[tag]);
    }
  });

  it.each([
    ['en', 'house rule'],
    ['en', 'never its Notes'],
    ['en', 'Set a PIN'],
    ['es', 'regla de la casa'],
    ['es', 'nunca sus Notas'],
    ['es', 'Pon un PIN'],
  ] as const)('%s PIN-off notice still contains "%s"', (tag, phrase) => {
    expect(pinOffNotice(tag)).toContain(phrase);
  });

  // The privacy policy's sharing sentence used to name a sitter link as the
  // one exception. A tag is another, and the sentence has to say so.
  it.each([
    ['en', 'a printed plant tag'],
    ['es', 'una etiqueta de planta impresa'],
  ] as const)('%s privacy policy names plant tags as a way plant data is shared', (tag, phrase) => {
    expect(sharingSentence(tag)).toContain(phrase);
  });
});

describe('a tag scan exposes nothing the sitter brief does not, except what the notice discloses', () => {
  it('fills every field of the scan, so no sub-shape hides behind a null', async () => {
    const { tagBody } = await readBothSurfaces(await seedEverything());
    expect(nullLeaves(tagBody)).toEqual([]);
  });

  it('SHAPE: every scan field is a brief field or a disclosed tag-only field', async () => {
    const { tagBody, briefEntry } = await readBothSurfaces(await seedEverything());

    const briefPaths = new Set(leafPaths(briefEntry));
    const tagPaths = uniq(leafPaths(tagBody));
    const isTagOnly = (path: string) => path.split(/[.[]/)[0]! in TAG_ONLY;
    const inBrief = (path: string) => briefPaths.has(RENAMED[path]?.briefField ?? path);

    const covered = tagPaths.filter(inBrief);
    const tagOnly = tagPaths.filter((p) => !inBrief(p) && isTagOnly(p));
    const unaccounted = tagPaths.filter((p) => !inBrief(p) && !isTagOnly(p));

    expect(
      unaccounted,
      `tag-scan fields also in the sitter brief: ${covered.length}/${tagPaths.length}; ` +
        `disclosed tag-only: ${tagOnly.length} [${tagOnly.join(', ')}]; ` +
        `neither: ${unaccounted.length} [${unaccounted.join(', ')}]`
    ).toEqual([]);
    // A rename must point at a field the brief really has.
    for (const { briefField } of Object.values(RENAMED)) {
      expect(briefPaths.has(briefField), `brief field \`${briefField}\``).toBe(true);
    }
  });

  it('VALUES: a field the scan shares with the brief carries the same datum', async () => {
    const { tagBody, briefEntry } = await readBothSurfaces(await seedEverything());

    const scalarPaths = uniq(leafPaths(tagBody)).filter(
      (p) => !p.includes('[]') && !(p.split('.')[0]! in TAG_ONLY)
    );
    expect(scalarPaths.length).toBeGreaterThan(0);
    for (const path of scalarPaths) {
      const rename = RENAMED[path];
      const tagValue = getPath(tagBody, path);
      const briefValue = getPath(briefEntry, rename?.briefField ?? path);
      const same = rename ? rename.sameDatum(tagValue, briefValue) : tagValue === briefValue;
      expect(
        same,
        `scan \`${path}\` = ${JSON.stringify(tagValue)} but brief \`${rename?.briefField ?? path}\` = ${JSON.stringify(briefValue)}`
      ).toBe(true);
    }
  });

  it('BYTES: every id, timestamp and planted marker outside the tag-only fields is one a sitter link already returns', async () => {
    const { tagBody, tagWire, sitterWire } = await readBothSurfaces(await seedEverything());

    const outsideTagOnly = Object.fromEntries(
      Object.entries(tagBody).filter(([key]) => !(key in TAG_ONLY))
    );
    const tokens = uniq(JSON.stringify(outsideTagOnly).match(DISTINCTIVE) ?? []);
    expect(tokens.length).toBeGreaterThan(0);
    const missing = tokens.filter((token) => !sitterWire.includes(token));
    expect(missing, 'in the tag scan but in no sitter-link response').toEqual([]);

    // The regression itself, stated plainly: the plant's free-text notes are
    // not in the scan at all, and the house rule is.
    expect(tagWire).not.toContain(PLANT_PRIVATE_NOTE);
    expect(tagWire).toContain(HOUSE_RULE);
  });

  it('the scan still carries nothing private that the sitter link does not, anywhere in its bytes', async () => {
    const { tagWire } = await readBothSurfaces(await seedEverything());
    for (const secret of [
      PLANT_PRIVATE_NOTE,
      SIBLING_NOTE,
      SIBLING_NAME,
      TASK_PRIVATE_NOTE,
      PLACEMENT_NOTE,
      SPACE_NAME,
      HOUSEHOLD_CITY,
      HOUSEHOLD_NAME,
      ADMIN.name,
      ADMIN.email,
      ADMIN.userId,
      MEMBER.email,
      MEMBER.userId,
      'MEMBERLAST-6T2',
      '34.05',
      '-118.24',
    ]) {
      expect(tagWire, `a tag scan must not contain "${secret}"`).not.toContain(secret);
    }
    // The one piece of member identity a scan does carry, and the reason
    // `history` is disclosed rather than covered: a first name.
    expect(tagWire).toContain('MELFIRST-4R7');
  });
});
