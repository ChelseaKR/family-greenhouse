/**
 * Every surface that shows a plant photo hands out a signed URL, and nothing
 * else (ADR 0033).
 *
 * Driven through the REAL handlers and their whole middleware chain, against
 * the in-memory table, for each place a household photo reaches a screen: the
 * household app (plant list, plant page, photo timeline, activity feed, away
 * recap, caretaker report) and the two public links that carry a photo (a
 * shared cutting and a sitter brief).
 *
 * Signing is real SigV4 with fake role credentials. Each URL a response hands
 * out is then put to `presignedGetOrigin`, which decides as S3 would and is
 * written from the SigV4 specification, not from the SDK that signs: it must
 * serve the photo now, refuse it once the URL's own expiry passes, and — for a
 * public link — that expiry must not fall after the link's.
 *
 * And no response may carry a stored photo REFERENCE (the unsigned form on the
 * plant row) anywhere at all, in any field. The one route allowed to is the
 * upload presign, whose `imageUrl` is what the confirm call sends back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler, type TestIdentity } from './support/invokeHandler.js';
import { createPresignedGetOrigin } from './support/presignedGetOrigin.js';
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
}));

const CREDENTIALS = {
  accessKeyId: 'AKIAPHOTOSURFACES',
  secretAccessKey: 'photo-surfaces-secret',
};
const BUCKET = 'fixture-images-bucket';
const ASSETS = 'https://app.fixture.invalid';
const ADMIN = { userId: 'user-admin', email: 'fixture-admin-contact', name: 'Ada Admin' };

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString();

const origin = createPresignedGetOrigin(CREDENTIALS, BUCKET);

/** Every string in a body that is a stored photo reference, wherever it sits. */
async function referencesIn(body: unknown): Promise<string[]> {
  const { storedPhotoKey } = await import('../../src/services/photoAccess.js');
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      if (storedPhotoKey(node)) found.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  };
  visit(body);
  return found;
}

/** Every signed photo URL in a body. */
function signedUrlsIn(body: unknown): string[] {
  return JSON.stringify(body).match(/https:\/\/[^"]+X-Amz-Signature=[0-9a-f]{64}[^"]*/g) ?? [];
}

/**
 * The property, for one response: at least `expected` signed URLs, each served
 * now and refused at its own expiry (and never later than `notAfter`), and no
 * unsigned reference anywhere in the body.
 */
async function expectOnlySignedPhotos(
  label: string,
  body: unknown,
  expected: number,
  notAfter?: string
) {
  expect(await referencesIn(body), `${label}: an unsigned photo reference`).toEqual([]);
  const urls = signedUrlsIn(body);
  expect(urls.length, `${label}: signed photo URLs`).toBeGreaterThanOrEqual(expected);
  const now = new Date();
  for (const url of urls) {
    expect(origin.get(url, now).status, `${label}: served now`).toBe(200);
    const expiresAt = origin.expiresAt(url)!;
    expect(origin.get(url, expiresAt), `${label}: refused at expiry`).toEqual({
      status: 403,
      reason: 'expired',
    });
    if (notAfter) {
      expect(expiresAt.getTime(), `${label}: outlives its link`).toBeLessThanOrEqual(
        Date.parse(notAfter)
      );
    }
  }
}

interface Seeded {
  householdId: string;
  plantId: string;
  identity: TestIdentity;
  sitterToken: string;
}

async function seed(): Promise<Seeded> {
  const plantService = await import('../../src/services/plantService.js');
  const { recordActivity } = await import('../../src/services/activity.js');
  const householdsHandler = await import('../../src/handlers/households/handler.js');

  const { householdId } = await seedHousehold(store, { name: 'Photo House', admin: ADMIN });
  await setHouseholdPlan(store, householdId, 'greenhouse');
  const identity: TestIdentity = { ...ADMIN, householdId };

  const plant = await plantService.createPlant(
    { name: 'Monstera' },
    householdId,
    ADMIN.userId,
    5000
  );
  const photo = (n: number) =>
    `${ASSETS}/plants/${householdId}/${plant.id}/0b7c0a4e-1111-4222-8333-94445555666${n}.jpg`;
  for (const n of [1, 2]) {
    await plantService.appendPlantPhoto(householdId, plant.id, photo(n), ADMIN.userId);
    origin.objects.set(new URL(photo(n)).pathname.slice(1), Buffer.from(`photo ${n}`));
  }

  const created = await invokeHandler(householdsHandler.createSitterLink, {
    method: 'POST',
    routeKey: 'POST /households/{id}/sitter-links',
    pathParameters: { id: householdId },
    identity,
    body: { expiresAt: inDays(7), label: 'Trip' },
  });
  expect(created.statusCode).toBe(201);
  const link = created.body as { token: string; id: string };

  // What the sitter photo-back route records, so the recap and the feed carry
  // a photo straight from the event.
  await plantService.appendPlantPhoto(householdId, plant.id, photo(3), `sitter:${link.id}`, null, {
    viaSitter: { linkId: link.id },
    setPrimaryImage: false,
  });
  origin.objects.set(new URL(photo(3)).pathname.slice(1), Buffer.from('photo 3'));
  await recordActivity({
    type: 'photo.uploaded',
    householdId,
    actorId: `sitter:${link.id}`,
    actorName: 'Plant sitter',
    payload: {
      plantId: plant.id,
      photoId: 'sitter-photo',
      plantName: 'Monstera',
      imageUrl: photo(3),
      caption: null,
      viaSitter: true,
      sitterLinkId: link.id,
    },
  });

  return { householdId, plantId: plant.id, identity, sitterToken: link.token };
}

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  origin.objects.clear();
  process.env.FRONTEND_URL = ASSETS;
  process.env.ASSETS_BASE_URL = ASSETS;
  process.env.IMAGES_BUCKET = BUCKET;
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = CREDENTIALS.secretAccessKey;
  delete process.env.AWS_SESSION_TOKEN;
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetPhotoSigningClientForTests } = await import('../../src/services/photoAccess.js');
  __resetPhotoSigningClientForTests();
});

const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('the household app gets signed photo URLs, and only those', () => {
  it('on the plant list, the plant page and the photo timeline', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { identity, plantId } = await seed();

    const list = await invokeHandler(plantsHandler.listPlants, {
      method: 'GET',
      routeKey: 'GET /plants',
      identity,
    });
    expect(list.statusCode).toBe(200);
    await expectOnlySignedPhotos('GET /plants', list.body, 1);

    const detail = await invokeHandler(plantsHandler.getPlant, {
      method: 'GET',
      routeKey: 'GET /plants/{id}',
      pathParameters: { id: plantId },
      identity,
    });
    expect(detail.statusCode).toBe(200);
    await expectOnlySignedPhotos('GET /plants/{id}', detail.body, 1);

    const timeline = await invokeHandler(plantsHandler.listPhotos, {
      method: 'GET',
      routeKey: 'GET /plants/{id}/photos',
      pathParameters: { id: plantId },
      identity,
    });
    expect(timeline.statusCode).toBe(200);
    await expectOnlySignedPhotos('GET /plants/{id}/photos', timeline.body, 3);
  });

  it('on the activity feed and the away recap', async () => {
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const { identity, householdId } = await seed();

    const feed = await invokeHandler(householdsHandler.handler, {
      method: 'GET',
      routeKey: 'GET /households/{id}/activity',
      pathParameters: { id: householdId },
      identity,
    });
    expect(feed.statusCode).toBe(200);
    await expectOnlySignedPhotos('GET /households/{id}/activity', feed.body, 1);

    // Close the sitter window around what already happened, so the recap has
    // an ended window to replay.
    const linkRow = store.all().find((i) => i.entityType === 'SitterLink')!;
    store.put({
      ...linkRow,
      startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expiresAt: new Date().toISOString(),
    });
    const recap = await invokeHandler(householdsHandler.handler, {
      method: 'GET',
      routeKey: 'GET /households/{id}/away-recap',
      pathParameters: { id: householdId },
      identity,
    });
    expect(recap.statusCode).toBe(200);
    await expectOnlySignedPhotos('GET /households/{id}/away-recap', recap.body, 1);
  });

  it('on the caretaker report', async () => {
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const caretakerService = await import('../../src/services/caretakerService.js');
    const { identity, householdId, plantId } = await seed();

    const seat = await caretakerService.createCaretaker({
      householdId,
      createdBy: ADMIN.userId,
      name: 'Casey',
      startsAt: new Date().toISOString(),
      expiresAt: inDays(7),
    });
    const reference = `${ASSETS}/plants/${householdId}/${plantId}/0b7c0a4e-1111-4222-8333-944455556661.jpg`;
    await caretakerService.recordCaretakerAction(seat, {
      kind: 'photo',
      entry: {
        photoId: 'caretaker-photo',
        plantId,
        plantName: 'Monstera',
        imageUrl: reference,
        at: new Date().toISOString(),
      },
    });

    const report = await invokeHandler(householdsHandler.handler, {
      method: 'GET',
      routeKey: 'GET /households/{id}/caretaker-report',
      pathParameters: { id: householdId },
      identity,
    });
    expect(report.statusCode).toBe(200);
    await expectOnlySignedPhotos('GET /households/{id}/caretaker-report', report.body, 1);
  });
});

describe('a public link signs its photo for as long as the link lives, and no longer', () => {
  it('a shared cutting', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { identity, plantId } = await seed();

    const shared = await invokeHandler(plantsHandler.sharePlant, {
      method: 'POST',
      routeKey: 'POST /plants/{id}/share',
      pathParameters: { id: plantId },
      identity,
    });
    expect(shared.statusCode).toBe(201);
    const { code, expiresAt } = shared.body as { code: string; expiresAt: string };

    // No credential but the code.
    const card = await invokeHandler(plantsHandler.getSharedPlant, {
      method: 'GET',
      routeKey: 'GET /plants/shared/{code}',
      pathParameters: { code },
    });
    expect(card.statusCode).toBe(200);
    await expectOnlySignedPhotos('GET /plants/shared/{code}', card.body, 1, expiresAt);
  });

  it('a shared cutting in its last minutes hands out a URL that ends with it', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { identity, plantId } = await seed();
    const shared = await invokeHandler(plantsHandler.sharePlant, {
      method: 'POST',
      routeKey: 'POST /plants/{id}/share',
      pathParameters: { id: plantId },
      identity,
    });
    const { code } = shared.body as { code: string };
    const endsSoon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const row = store.all().find((i) => i.entityType === 'PlantShare')!;
    store.put({ ...row, expiresAt: endsSoon });

    const card = await invokeHandler(plantsHandler.getSharedPlant, {
      method: 'GET',
      routeKey: 'GET /plants/shared/{code}',
      pathParameters: { code },
    });
    await expectOnlySignedPhotos('GET /plants/shared/{code} (ending)', card.body, 1, endsSoon);
  });

  it('a sitter brief', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const { sitterToken } = await seed();
    const linkRow = store.all().find((i) => i.entityType === 'SitterLink')!;

    const brief = await invokeHandler(tasksHandler.getSitterBrief, {
      method: 'GET',
      routeKey: 'GET /sitter/{token}/brief',
      pathParameters: { token: sitterToken },
    });
    expect(brief.statusCode).toBe(200);
    await expectOnlySignedPhotos(
      'GET /sitter/{token}/brief',
      brief.body,
      1,
      String(linkRow.expiresAt)
    );
  });
});

describe('the one route that returns the reference itself', () => {
  it('the upload presign: its imageUrl is what the confirm call sends back', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { identity, plantId, householdId } = await seed();
    const presign = await invokeHandler(plantsHandler.getImageUploadUrl, {
      method: 'POST',
      routeKey: 'POST /plants/{id}/image',
      pathParameters: { id: plantId },
      identity,
      body: { contentType: 'image/jpeg' },
    });
    expect(presign.statusCode).toBe(200);
    const { imageUrl } = presign.body as { imageUrl: string };
    expect(imageUrl.startsWith(`${ASSETS}/plants/${householdId}/${plantId}/`)).toBe(true);
    expect(new URL(imageUrl).search).toBe('');
  });
});

describe('negative control: the sweep can fail', () => {
  it('flags a response built without the signer, and passes the same response with it', async () => {
    const { createHandler } = await import('../../src/middleware/handler.js');
    const { successResponse } = await import('../../src/utils/response.js');
    const { householdId } = await seed();
    const reference = `${ASSETS}/plants/${householdId}/p-1/0b7c0a4e-1111-4222-8333-944455556661.jpg`;
    const body = () => successResponse({ plants: [{ id: 'p-1', imageUrl: reference }] });
    const event = {
      headers: {},
      requestContext: { identity: { sourceIp: '127.0.0.1' } },
      user: { userId: ADMIN.userId, householdId },
    };
    const context = { awsRequestId: 't' } as never;

    const withoutSigner = createHandler(async () => body(), { signPhotoUrls: false });
    const unsigned = JSON.parse((await withoutSigner(event as never, context)).body);
    expect(await referencesIn(unsigned)).toEqual([reference]);
    expect(signedUrlsIn(unsigned)).toEqual([]);

    const withSigner = createHandler(async () => body());
    const signed = JSON.parse((await withSigner(event as never, context)).body);
    expect(await referencesIn(signed)).toEqual([]);
    expect(signedUrlsIn(signed)).toHaveLength(1);
  });
});
