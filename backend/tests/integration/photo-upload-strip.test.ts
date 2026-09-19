/**
 * Every route that stores a plant photo removes its location first, on the
 * server, whatever the client did (services/photoIntake.ts).
 *
 * #849 strips metadata on the device; an app build from before it, or any
 * client calling the API directly, still sends the photo as it was taken. So
 * each upload path is driven here through the REAL handler and its middleware,
 * with a phone JPEG carrying GPS and an iPhone HEIC carrying GPS:
 *
 *   - a member's upload confirm       POST /plants/{id}/image/confirm
 *   - a caretaker's upload confirm    POST /caretaker/{token}/plants/{plantId}/photo/confirm
 *   - a sitter's photo-back           POST /sitter/{token}/photos
 *
 * and then the bucket itself is PARSED: the object a plant ends up pointing
 * at, and every version of it, must carry no location. A HEIC is refused and
 * leaves nothing behind. DynamoDB is the in-memory table; S3 is an in-memory
 * versioned bucket that enforces If-Match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler, type TestIdentity } from './support/invokeHandler.js';
import { seedHousehold, setHouseholdPlan } from './support/seed.js';
import { contains, latitudeBytes, phoneJpeg, TINY_JPEG } from '../unit/services/photoFixtures.js';
import { iphoneHeicWithGps } from '../unit/services/uploadFixtures.js';
import { carriesLocation, inspectPhotoMetadata } from '../../src/services/photoMetadata.js';

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

interface Version {
  key: string;
  body: Uint8Array;
  contentType: string;
  etag: string;
  versionId: string;
}
const bucket = {
  current: new Map<string, Version>(),
  versions: [] as Version[],
  serial: 0,
  reset() {
    this.current.clear();
    this.versions = [];
    this.serial = 0;
  },
  put(key: string, body: Uint8Array, contentType: string) {
    this.serial += 1;
    const v = { key, body, contentType, etag: `"e${this.serial}"`, versionId: `v${this.serial}` };
    this.current.set(key, v);
    this.versions.push(v);
  },
};

vi.mock('../../src/utils/s3.js', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/s3.js')>();
  return {
    ...actual,
    IMAGES_BUCKET: 'images-bucket',
    s3: {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const { input } = command;
        const key = input.Key as string;
        switch (command.constructor.name) {
          case 'HeadObjectCommand': {
            const v = bucket.current.get(key);
            if (!v) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
            return { ContentLength: v.body.length, ContentType: v.contentType, ETag: v.etag };
          }
          case 'GetObjectCommand': {
            const v = bucket.current.get(key);
            if (!v) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
            return {
              Body: { transformToByteArray: async () => v.body },
              ContentType: v.contentType,
              ETag: v.etag,
              VersionId: v.versionId,
            };
          }
          case 'PutObjectCommand': {
            if (input.IfMatch !== undefined && bucket.current.get(key)?.etag !== input.IfMatch) {
              throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
            }
            bucket.put(key, new Uint8Array(input.Body as Uint8Array), input.ContentType as string);
            return {};
          }
          case 'DeleteObjectCommand': {
            if (input.VersionId) {
              bucket.versions = bucket.versions.filter(
                (v) => !(v.key === key && v.versionId === input.VersionId)
              );
              if (bucket.current.get(key)?.versionId === input.VersionId) {
                bucket.current.delete(key);
              }
            } else {
              bucket.current.delete(key);
            }
            return {};
          }
          default:
            throw new Error(`unexpected ${command.constructor.name}`);
        }
      },
    },
  };
});

const ASSETS = 'https://app.fixture.invalid';
const ADMIN = { userId: 'user-admin', email: 'fixture-admin-contact', name: 'Ada Admin' };
const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

function expectNoLocation(bytes: Uint8Array, label: string) {
  expect(carriesLocation(inspectPhotoMetadata(bytes)), label).toBe(false);
  expect(contains(bytes, latitudeBytes()), label).toBe(false);
}

/** Every version the bucket holds for the objects under a plant. */
function versionsFor(householdId: string, plantId: string): Version[] {
  return bucket.versions.filter((v) => v.key.startsWith(`plants/${householdId}/${plantId}/`));
}

async function seed() {
  const plantService = await import('../../src/services/plantService.js');
  const { householdId } = await seedHousehold(store, { name: 'Strip House', admin: ADMIN });
  await setHouseholdPlan(store, householdId, 'greenhouse');
  const plant = await plantService.createPlant(
    { name: 'Monstera' },
    householdId,
    ADMIN.userId,
    5000
  );
  const identity: TestIdentity = { ...ADMIN, householdId };
  return { householdId, plantId: plant.id, identity };
}

/** A presigned PUT, as the phone would make it: the bytes land at a minted key. */
function uploadAs(householdId: string, plantId: string, bytes: Uint8Array, contentType: string) {
  const key = `plants/${householdId}/${plantId}/${crypto.randomUUID()}.jpg`;
  bucket.put(key, bytes, contentType);
  return { key, imageUrl: `${ASSETS}/${key}` };
}

beforeEach(async () => {
  store.reset();
  bucket.reset();
  process.env.ASSETS_BASE_URL = ASSETS;
  process.env.FRONTEND_URL = ASSETS;
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetSitterPhotoLimiterForTests } =
    await import('../../src/services/sitterPhotoPolicy.js');
  __resetSitterPhotoLimiterForTests();
});

const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('a member upload', () => {
  it('a phone JPEG with GPS is attached without it, and no version of it keeps GPS', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const plantService = await import('../../src/services/plantService.js');
    const { householdId, plantId, identity } = await seed();
    const upload = uploadAs(householdId, plantId, phoneJpeg(), 'image/jpeg');
    expect(carriesLocation(inspectPhotoMetadata(bucket.current.get(upload.key)!.body))).toBe(true);

    const confirmed = await invokeHandler(plantsHandler.confirmImageUpload, {
      method: 'POST',
      routeKey: 'POST /plants/{id}/image/confirm',
      pathParameters: { id: plantId },
      identity,
      body: { imageUrl: upload.imageUrl },
    });
    expect(confirmed.statusCode).toBe(200);

    const plant = await plantService.getPlant(householdId, plantId);
    expect(plant?.imageUrl).toBe(upload.imageUrl);
    expectNoLocation(bucket.current.get(upload.key)!.body, 'the attached photo');
    for (const v of versionsFor(householdId, plantId)) expectNoLocation(v.body, v.versionId);
  });

  it('an iPhone HEIC with GPS is refused, not attached, and nothing of it is kept', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const plantService = await import('../../src/services/plantService.js');
    const { householdId, plantId, identity } = await seed();
    const upload = uploadAs(householdId, plantId, iphoneHeicWithGps(), 'image/jpeg');

    const confirmed = await invokeHandler(plantsHandler.confirmImageUpload, {
      method: 'POST',
      routeKey: 'POST /plants/{id}/image/confirm',
      pathParameters: { id: plantId },
      identity,
      body: { imageUrl: upload.imageUrl },
    });
    expect(confirmed.statusCode).toBe(400);
    expect((await plantService.getPlant(householdId, plantId))?.imageUrl ?? null).toBeNull();
    expect(await plantService.getPlantPhotos(householdId, plantId)).toEqual([]);
    expect(versionsFor(householdId, plantId)).toEqual([]);
  });
});

describe('a caretaker upload', () => {
  it('a phone JPEG with GPS is attached without it; a HEIC is refused', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const caretakerService = await import('../../src/services/caretakerService.js');
    const { householdId, plantId } = await seed();
    const seat = await caretakerService.createCaretaker({
      householdId,
      createdBy: ADMIN.userId,
      name: 'Casey',
      startsAt: new Date().toISOString(),
      expiresAt: inDays(7),
    });
    const confirm = (imageUrl: string) =>
      invokeHandler(plantsHandler.handler, {
        method: 'POST',
        routeKey: 'POST /caretaker/{token}/plants/{plantId}/photo/confirm',
        pathParameters: { token: seat.token, plantId },
        body: { imageUrl },
      });

    const jpeg = uploadAs(householdId, plantId, phoneJpeg(), 'image/jpeg');
    expect((await confirm(jpeg.imageUrl)).statusCode).toBe(200);
    expectNoLocation(bucket.current.get(jpeg.key)!.body, 'the caretaker photo');

    const heic = uploadAs(householdId, plantId, iphoneHeicWithGps(), 'image/jpeg');
    expect((await confirm(heic.imageUrl)).statusCode).toBe(400);
    expect(bucket.versions.some((v) => v.key === heic.key)).toBe(false);
    for (const v of versionsFor(householdId, plantId)) expectNoLocation(v.body, v.versionId);
  });
});

describe("a sitter's photo-back", () => {
  async function linkAndTask() {
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const taskService = await import('../../src/services/taskService.js');
    const seeded = await seed();
    const task = await taskService.createTask(
      { plantId: seeded.plantId, type: 'water', frequency: 7, nextDue: inDays(1) },
      seeded.householdId,
      ADMIN.userId,
      'Monstera'
    );
    const created = await invokeHandler(householdsHandler.createSitterLink, {
      method: 'POST',
      routeKey: 'POST /households/{id}/sitter-links',
      pathParameters: { id: seeded.householdId },
      identity: seeded.identity,
      body: { expiresAt: inDays(7), label: 'Trip' },
    });
    expect(created.statusCode).toBe(201);
    return { ...seeded, taskId: task.id, token: (created.body as { token: string }).token };
  }

  it('stores a phone JPEG without its GPS, and refuses a HEIC', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const { householdId, plantId, taskId, token } = await linkAndTask();
    const send = (bytes: Uint8Array) =>
      invokeHandler(tasksHandler.handler, {
        method: 'POST',
        routeKey: 'POST /sitter/{token}/photos',
        pathParameters: { token },
        body: { taskId, image: Buffer.from(bytes).toString('base64') },
      });

    expect((await send(phoneJpeg())).statusCode).toBe(201);
    const stored = versionsFor(householdId, plantId);
    expect(stored).toHaveLength(1);
    expectNoLocation(stored[0].body, 'the sitter photo');
    expect(inspectPhotoMetadata(stored[0].body).orientation).toBe(6);

    expect((await send(iphoneHeicWithGps())).statusCode).toBe(400);
    expect(versionsFor(householdId, plantId)).toHaveLength(1);
  });

  it('negative control: a clean photo is stored byte for byte, so the strip is not a re-encode', async () => {
    const tasksHandler = await import('../../src/handlers/tasks/handler.js');
    const { householdId, plantId, taskId, token } = await linkAndTask();
    const sent = await invokeHandler(tasksHandler.handler, {
      method: 'POST',
      routeKey: 'POST /sitter/{token}/photos',
      pathParameters: { token },
      body: { taskId, image: TINY_JPEG.toString('base64') },
    });
    expect(sent.statusCode).toBe(201);
    const [stored] = versionsFor(householdId, plantId);
    expect(Buffer.from(stored.body).equals(TINY_JPEG)).toBe(true);
  });
});
