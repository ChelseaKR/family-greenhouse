/**
 * Household trash (#670) — the service, against the in-memory single table
 * (tests/integration/support/inMemoryDynamo.ts) and a fake images bucket.
 *
 * The claims these pin, in the order the issue states them:
 *   - a trashed plant leaves EVERY live key: no row outside the trash that
 *     mentions it survives except the activity log (history, as before);
 *   - restore within 30 days brings back the plant, its tasks, photo
 *     timeline, completions, printed tag and share link byte-for-byte, and
 *     its images at the same keys;
 *   - restore into a household at its plant cap is refused and changes
 *     nothing;
 *   - the purge removes only entries past 30 days and reports counts; a
 *     throttled batch is retried, not dropped (#603's test, reused);
 *   - erasure bypasses the window, and a departing member is scrubbed from
 *     the trash the same way they are scrubbed from live rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createInMemoryDynamo } from '../../integration/support/inMemoryDynamo.js';
import { seedHousehold } from '../../integration/support/seed.js';

const store = createInMemoryDynamo();

/** Batches to decline (the first write of each) before passing through;
 *  `Infinity` declines forever. Mirrors DynamoDB's HTTP-200 partial throttle. */
const throttle = { declineBatches: 0 };

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'BatchWriteCommand' && throttle.declineBatches > 0) {
        throttle.declineBatches -= 1;
        const writes = (command.input.RequestItems as Record<string, unknown[]>)['test-table'];
        const [declined, ...accepted] = writes;
        if (accepted.length > 0) {
          await store.client.send(
            new BatchWriteCommand({ RequestItems: { 'test-table': accepted as never } }) as never
          );
        }
        return { UnprocessedItems: { 'test-table': [declined] } };
      }
      return store.client.send(command as never);
    },
  },
  TABLE_NAME: 'test-table',
}));

// A fake images bucket: current objects plus a count of versions removed.
const bucket = new Map<string, string>();
const removedVersions: string[] = [];
const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => {
  const command = (kind: string) =>
    vi.fn(function (input: Record<string, unknown>) {
      return { input, kind };
    });
  return {
    S3Client: vi.fn(function () {
      return { send: s3Send };
    }),
    ListObjectsV2Command: command('ListObjectsV2'),
    CopyObjectCommand: command('CopyObject'),
    DeleteObjectCommand: command('DeleteObject'),
    ListObjectVersionsCommand: command('ListObjectVersions'),
    DeleteObjectsCommand: command('DeleteObjects'),
  };
});

function installBucket(): void {
  s3Send.mockImplementation(async (cmd: { kind: string; input: Record<string, unknown> }) => {
    const { kind, input } = cmd;
    if (kind === 'ListObjectsV2') {
      const prefix = String(input.Prefix);
      return {
        Contents: [...bucket.keys()].filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })),
        IsTruncated: false,
      };
    }
    if (kind === 'CopyObject') {
      const source = decodeURIComponent(String(input.CopySource).replace(/^imgs\//, ''));
      if (!bucket.has(source)) throw new Error(`NoSuchKey ${source}`);
      bucket.set(String(input.Key), bucket.get(source)!);
      return {};
    }
    if (kind === 'DeleteObject') {
      bucket.delete(String(input.Key));
      return {};
    }
    if (kind === 'ListObjectVersions') {
      const prefix = String(input.Prefix);
      return {
        Versions: [...bucket.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((Key) => ({ Key, VersionId: 'v1' })),
        IsTruncated: false,
      };
    }
    if (kind === 'DeleteObjects') {
      for (const object of (input.Delete as { Objects: Array<{ Key: string }> }).Objects) {
        bucket.delete(object.Key);
        removedVersions.push(object.Key);
      }
      return {};
    }
    throw new Error(`unexpected S3 command ${kind}`);
  });
}

vi.mock('../../../src/services/cognitoUsers.js', () => ({
  getUserName: async () => 'Ada Admin',
  getUserEmail: async () => null,
  getUsersByIds: async () => new Map(),
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.invalid', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.invalid', name: 'Mel Member' };
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-09-17T12:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY_MS);

beforeAll(() => {
  process.env.IMAGES_BUCKET = 'imgs';
});
afterAll(() => {
  delete process.env.IMAGES_BUCKET;
});

beforeEach(async () => {
  store.reset();
  bucket.clear();
  removedVersions.length = 0;
  throttle.declineBatches = 0;
  vi.clearAllMocks();
  installBucket();
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
});

const silence = vi.spyOn(console, 'log').mockImplementation(() => {});
afterAll(() => silence.mockRestore());

interface Seeded {
  householdId: string;
  plantId: string;
  taskId: string;
  tagToken: string;
  shareCode: string;
  photoKey: string;
}

/** A household with one fully furnished plant and one bystander plant. */
async function seedFurnishedPlant(): Promise<Seeded> {
  const plantService = await import('../../../src/services/plantService.js');
  const taskService = await import('../../../src/services/taskService.js');
  const plantTagService = await import('../../../src/services/plantTagService.js');
  const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });

  const plant = await plantService.createPlant(
    { name: 'Monstera', notes: 'private note', careRule: 'bottom-water' },
    householdId,
    ADMIN.userId,
    5000
  );
  await plantService.createPlant({ name: 'Bystander fern' }, householdId, ADMIN.userId, 5000);
  const task = await taskService.createTask(
    { plantId: plant.id, type: 'water', frequency: 7, assignedTo: MEMBER.userId },
    householdId,
    ADMIN.userId,
    'Monstera'
  );
  await taskService.completeTask(householdId, task.id, MEMBER.userId, MEMBER.name);
  const photoKey = `plants/${householdId}/${plant.id}/pic-1.jpg`;
  bucket.set(photoKey, 'jpeg-bytes');
  await plantService.appendPlantPhoto(
    householdId,
    plant.id,
    `https://cdn.example.invalid/${photoKey}`,
    MEMBER.userId,
    'new leaf'
  );
  const tag = await plantTagService.issueTag({
    householdId,
    plantId: plant.id,
    createdBy: MEMBER.userId,
  });
  const share = await plantService.createPlantShare(householdId, plant.id, MEMBER.userId);
  return {
    householdId,
    plantId: plant.id,
    taskId: task.id,
    tagToken: tag.token,
    shareCode: share!.code,
    photoKey,
  };
}

/** Every row outside the trash and the activity log, in a stable order. */
function liveRows(): Array<Record<string, unknown>> {
  return store
    .all()
    .filter((row) => {
      const pk = String(row.PK);
      const sk = String(row.SK);
      if (pk.includes('#TRASH#') || sk.startsWith('TRASH#')) return false;
      if (pk.endsWith('#ACTIVITY') || pk.startsWith('SCHEDULED#')) return false;
      return true;
    })
    .sort((a, b) =>
      `${String(a.PK)}|${String(a.SK)}`.localeCompare(`${String(b.PK)}|${String(b.SK)}`)
    );
}

const actor = { userId: ADMIN.userId, name: ADMIN.name };

describe('trashPlant', () => {
  it('moves the plant and everything that belongs to it out of every live key', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const plantTagService = await import('../../../src/services/plantTagService.js');
    const seeded = await seedFurnishedPlant();

    const entry = await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);

    expect(entry).toMatchObject({
      kind: 'plant',
      id: seeded.plantId,
      name: 'Monstera',
      deletedByName: 'Ada Admin',
      purgeAfter: at(30).toISOString(),
      contents: { tasks: 1, photos: 1, completions: 1 },
      restoring: false,
    });
    // The generic claim: outside the trash, nothing mentions the plant except
    // the activity log. A read path nobody thought of has nothing to find.
    const mentions = liveRows().filter((row) => JSON.stringify(row).includes(seeded.plantId));
    expect(mentions).toEqual([]);
    // …and the specific reads the product makes, spot-checked.
    expect(await plantService.getPlant(seeded.householdId, seeded.plantId)).toBeNull();
    expect((await plantService.getPlants(seeded.householdId, 'all')).map((p) => p.name)).toEqual([
      'Bystander fern',
    ]);
    expect(await taskService.getTasks(seeded.householdId)).toEqual([]);
    expect(await plantService.getPlantPhotos(seeded.householdId, seeded.plantId)).toEqual([]);
    expect(await plantTagService.getActiveTag(seeded.tagToken)).toBeNull();
    expect(await plantService.getPlantShare(seeded.shareCode)).toBeNull();
    // The photo left the CloudFront-served prefix.
    expect(bucket.has(seeded.photoKey)).toBe(false);
    expect(bucket.has(`trash/${seeded.photoKey}`)).toBe(true);
  });

  it('frees the cap slot of an active plant, and not of an archived one', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const plantService = await import('../../../src/services/plantService.js');
    const seeded = await seedFurnishedPlant();
    const count = () =>
      store.all().find((r) => r.PK === `HOUSEHOLD#${seeded.householdId}` && r.SK === 'METADATA')
        ?.plantCount;
    expect(count()).toBe(2);
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    expect(count()).toBe(1);

    const archived = await plantService.createPlant(
      { name: 'Resting' },
      seeded.householdId,
      ADMIN.userId,
      5000
    );
    await plantService.updatePlant(seeded.householdId, archived.id, { status: 'archived' }, 5000);
    expect(count()).toBe(1);
    await trash.trashPlant(seeded.householdId, archived.id, actor, T0);
    expect(count()).toBe(1);
  });

  it('returns null for a plant that is not live, and for one already in the trash', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    expect(await trash.trashPlant(seeded.householdId, 'no-such-plant', actor, T0)).toBeNull();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    expect(await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0)).toBeNull();
  });
});

describe('restoreEntry (plant)', () => {
  it('brings back every row byte-for-byte and the images at the same keys', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    const before = liveRows();

    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    expect(liveRows()).not.toEqual(before); // negative control: the trash DID move rows
    const restored = await trash.restoreEntry(
      seeded.householdId,
      'plant',
      seeded.plantId,
      { maxPlants: 10 },
      at(2)
    );

    expect(restored).toMatchObject({ kind: 'plant', id: seeded.plantId, restoring: false });
    expect(liveRows()).toEqual(before);
    expect(bucket.has(seeded.photoKey)).toBe(true);
    expect(bucket.has(`trash/${seeded.photoKey}`)).toBe(false);
    // Nothing is left behind in the trash.
    expect(store.all().filter((r) => String(r.PK).includes('#TRASH#'))).toEqual([]);
    expect(await trash.listTrash(seeded.householdId, at(2))).toEqual([]);
  });

  it('does not bring back a share link whose own 14-day life ended while it was in the trash', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const plantService = await import('../../../src/services/plantService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    const share = store
      .all()
      .find((r) => (r.item as { entityType?: string } | undefined)?.entityType === 'PlantShare');
    const expiresAt = Date.parse(String((share?.item as { expiresAt: string }).expiresAt));

    await trash.restoreEntry(
      seeded.householdId,
      'plant',
      seeded.plantId,
      { maxPlants: null },
      new Date(expiresAt + DAY_MS)
    );

    expect(await plantService.getPlant(seeded.householdId, seeded.plantId)).not.toBeNull();
    expect(store.all().some((r) => r.PK === `SHARE#${seeded.shareCode}`)).toBe(false);
  });

  it('refuses a restore that would exceed the plant cap, and changes nothing', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const plantService = await import('../../../src/services/plantService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    // Fill the freed slot: two active plants against a cap of two.
    await plantService.createPlant({ name: 'Newcomer' }, seeded.householdId, ADMIN.userId, 2);
    const snapshot = store.all();

    await expect(
      trash.restoreEntry(seeded.householdId, 'plant', seeded.plantId, { maxPlants: 2 }, at(1))
    ).rejects.toMatchObject({ name: 'PlanLimitError' });
    expect(store.all()).toEqual(snapshot);
  });

  it('refuses an entry past its 30 days, and one that does not exist', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    await expect(
      trash.restoreEntry(seeded.householdId, 'plant', seeded.plantId, { maxPlants: null }, at(30))
    ).rejects.toMatchObject({ name: 'TrashEntryExpiredError' });
    await expect(
      trash.restoreEntry(seeded.householdId, 'plant', 'nope', { maxPlants: null }, at(1))
    ).rejects.toMatchObject({ name: 'TrashEntryNotFoundError' });
  });

  it('never revives a tag or share link whose issuer has since left, and unassigns their tasks', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const householdService = await import('../../../src/services/householdService.js');
    const plantTagService = await import('../../../src/services/plantTagService.js');
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    // The member who minted both credentials and holds the task leaves —
    // directly, without the anonymize sweep, to prove restore's own lock.
    await householdService.removeMember(seeded.householdId, MEMBER.userId);

    await trash.restoreEntry(seeded.householdId, 'plant', seeded.plantId, { maxPlants: null }, T0);

    expect(await plantTagService.getActiveTag(seeded.tagToken)).toBeNull();
    expect(await plantService.getPlantShare(seeded.shareCode)).toBeNull();
    const [task] = await taskService.getTasks(seeded.householdId);
    expect(task.id).toBe(seeded.taskId);
    expect(task.assignedTo).toBeNull();
    expect(
      store
        .all()
        .some((r) => r.GSI2PK === `HOUSEHOLD#${seeded.householdId}#ASSIGNEE#${MEMBER.userId}`)
    ).toBe(false);
  });

  it('finishes an interrupted restore on the next attempt, from a trash, or from the purge', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    const before = liveRows();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);

    // The image step fails once, after the root is back.
    s3Send.mockImplementationOnce(async () => {
      throw new Error('S3 unavailable');
    });
    await expect(
      trash.restoreEntry(seeded.householdId, 'plant', seeded.plantId, { maxPlants: null }, T0)
    ).rejects.toThrow('S3 unavailable');
    const [listed] = await trash.listTrash(seeded.householdId, T0);
    expect(listed).toMatchObject({ id: seeded.plantId, restoring: true });
    await expect(
      trash.purgeEntry(seeded.householdId, 'plant', seeded.plantId)
    ).rejects.toMatchObject({ name: 'TrashConflictError' });

    // Past the window, the purge job completes the restore rather than
    // deleting a plant the household can already see. (The share link's own
    // 14-day life is over by day 45, so it alone stays gone.)
    const run = await trash.purgeExpired(seeded.householdId, at(45));
    expect(run.failed).toBe(0);
    const withoutShare = (rows: Array<Record<string, unknown>>) =>
      rows.filter((r) => r.entityType !== 'PlantShare');
    expect(withoutShare(liveRows())).toEqual(withoutShare(before));
    expect(liveRows().some((r) => r.entityType === 'PlantShare')).toBe(false);
    expect(await trash.listTrash(seeded.householdId, at(45))).toEqual([]);
  });

  it('a trash of a half-restored plant completes the restore first, then trashes it whole', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    s3Send.mockImplementationOnce(async () => {
      throw new Error('S3 unavailable');
    });
    await expect(
      trash.restoreEntry(seeded.householdId, 'plant', seeded.plantId, { maxPlants: null }, T0)
    ).rejects.toThrow();

    const again = await trash.trashPlant(seeded.householdId, seeded.plantId, actor, at(1));
    expect(again).toMatchObject({ contents: { tasks: 1, photos: 1, completions: 1 } });
  });
});

describe('tasks', () => {
  it('trashes and restores a task intact; its completions never moved', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const seeded = await seedFurnishedPlant();
    const before = liveRows();

    const entry = await trash.trashTask(seeded.householdId, seeded.taskId, actor, T0);
    expect(entry).toMatchObject({ kind: 'task', taskType: 'water', plantName: 'Monstera' });
    expect(await taskService.getTasks(seeded.householdId)).toEqual([]);
    expect(
      liveRows().some((r) => r.entityType === 'TaskCompletion' && r.taskId === seeded.taskId)
    ).toBe(true);

    await trash.restoreEntry(seeded.householdId, 'task', seeded.taskId, { maxPlants: 0 }, at(2));
    expect(liveRows()).toEqual(before);
  });

  it('will not restore a task without its plant, and says which case it is', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashTask(seeded.householdId, seeded.taskId, actor, T0);
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);

    await expect(
      trash.restoreEntry(seeded.householdId, 'task', seeded.taskId, { maxPlants: null }, T0)
    ).rejects.toMatchObject({ name: 'TrashRestoreBlockedError', reason: 'plant_in_trash' });

    // Purging the plant takes its separately trashed task with it: it could
    // never come back.
    const counts = await trash.purgeEntry(seeded.householdId, 'plant', seeded.plantId);
    // Its only task had already been trashed on its own, so the one counted
    // is that orphaned entry, not a dependent.
    expect(counts?.tasks).toBe(1);
    expect(await trash.getEntry(seeded.householdId, 'task', seeded.taskId)).toBeNull();
  });

  it('reports plant_gone when the plant was deleted outright', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const plantService = await import('../../../src/services/plantService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashTask(seeded.householdId, seeded.taskId, actor, T0);
    await plantService.deletePlant(seeded.householdId, seeded.plantId);
    await expect(
      trash.restoreEntry(seeded.householdId, 'task', seeded.taskId, { maxPlants: null }, T0)
    ).rejects.toMatchObject({ name: 'TrashRestoreBlockedError', reason: 'plant_gone' });
  });
});

describe('purge', () => {
  it('purges only entries past 30 days and reports per-kind counts', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);

    const early = await trash.purgeExpired(seeded.householdId, at(29.9));
    expect(early.counts).toEqual(trash.emptyPurgeCounts());
    expect(await trash.getEntry(seeded.householdId, 'plant', seeded.plantId)).not.toBeNull();

    const due = await trash.purgeExpired(seeded.householdId, at(30));
    expect(due).toEqual({
      counts: {
        plants: 1,
        tasks: 1,
        photos: 1,
        completions: 1,
        otherRows: 2, // the plant tag and the share link
        s3Objects: 1,
      },
      failed: 0,
    });
    expect(store.all().filter((r) => JSON.stringify(r).includes(seeded.plantId))).toEqual(
      store.all().filter((r) => String(r.PK).endsWith('#ACTIVITY'))
    );
    expect(bucket.size).toBe(0);
  });

  it('retries a throttled batch instead of dropping it (#603, reused)', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    const wrapped = () =>
      store
        .all()
        .filter((r) => String(r.PK) === trash.dependentsPk(seeded.householdId, seeded.plantId));
    expect(wrapped().length).toBeGreaterThan(0);

    throttle.declineBatches = 1;
    await trash.purgeEntry(seeded.householdId, 'plant', seeded.plantId);
    expect(throttle.declineBatches).toBe(0); // the sabotage really fired
    expect(wrapped()).toEqual([]);
    expect(await trash.getEntry(seeded.householdId, 'plant', seeded.plantId)).toBeNull();
  });

  it('keeps the entry when a batch stays declined, so the next run can finish it', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);

    throttle.declineBatches = Infinity;
    await expect(trash.purgeEntry(seeded.householdId, 'plant', seeded.plantId)).rejects.toThrow(
      /unprocessed/
    );
    throttle.declineBatches = 0;
    expect(await trash.getEntry(seeded.householdId, 'plant', seeded.plantId)).not.toBeNull();
    const retry = await trash.purgeExpired(seeded.householdId, at(31));
    expect(retry.counts.plants).toBe(1);
  });

  it('runs across households with a summary the digests alarms read', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const { logger } = await import('../../../src/utils/logger.js');
    const info = vi.spyOn(logger, 'info');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    await trash.trashTask(seeded.householdId, 'nope', actor, T0); // a no-op: nothing to trash

    const summary = await trash.runTrashPurge(at(31));
    expect(summary).toMatchObject({ households: 1, attempted: 1, failed: 0, truncated: false });
    expect(summary.purged.plants).toBe(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'trash.purge_run_complete', failed: 0, truncated: false }),
      'trash.purge_run_complete'
    );
  });

  it('erasure purges every entry regardless of age', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    const counts = await trash.purgeAllTrash(seeded.householdId);
    expect(counts.plants).toBe(1);
    expect(store.all().filter((r) => String(r.PK).includes('#TRASH#'))).toEqual([]);
    expect(store.all().filter((r) => String(r.SK).startsWith('TRASH#'))).toEqual([]);
    expect(bucket.size).toBe(0);
  });
});

describe('anonymizeUserInTrash', () => {
  it('scrubs a departing member from trashed rows and drops the credentials they minted', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(
      seeded.householdId,
      seeded.plantId,
      { userId: MEMBER.userId, name: MEMBER.name },
      T0
    );
    const wrappedBefore = store
      .all()
      .filter((r) => String(r.PK) === trash.dependentsPk(seeded.householdId, seeded.plantId));
    // Negative control: before the sweep the member IS in there.
    expect(JSON.stringify(wrappedBefore)).toContain(MEMBER.userId);

    await trash.anonymizeUserInTrash(seeded.householdId, MEMBER.userId);

    const after = store
      .all()
      .filter(
        (r) =>
          String(r.PK) === trash.dependentsPk(seeded.householdId, seeded.plantId) ||
          String(r.SK).startsWith('TRASH#')
      );
    const dump = JSON.stringify(after);
    expect(dump).not.toContain(MEMBER.userId);
    expect(dump).not.toContain(MEMBER.name);
    expect(dump).toContain(trash.DELETED_USER_NAME);
    const types = after.map((r) => (r.item as { entityType?: string } | undefined)?.entityType);
    expect(types).not.toContain('PlantTag');
    expect(types).not.toContain('PlantShare');
    // The pseudonym is the one live rows get (accountCleanup's constant).
    expect(trash.DELETED_USER_ID).toBe('deleted-user');
  });

  it('leaves everyone else untouched', async () => {
    const trash = await import('../../../src/services/trashService.js');
    const seeded = await seedFurnishedPlant();
    await trash.trashPlant(seeded.householdId, seeded.plantId, actor, T0);
    const snapshot = store.all();
    await trash.anonymizeUserInTrash(seeded.householdId, 'someone-else');
    expect(store.all()).toEqual(snapshot);
  });
});

describe('moveImagePrefix', () => {
  it('encodes the copy source and deletes only after the copy', async () => {
    const trash = await import('../../../src/services/trashService.js');
    bucket.set('plants/h/p/a b.jpg', 'x');
    const moved = await trash.moveImagePrefix('plants/h/p/', 'trash/plants/h/p/');
    expect(moved).toBe(1);
    const kinds = s3Send.mock.calls.map(([c]) => (c as { kind: string }).kind);
    expect(kinds).toEqual(['ListObjectsV2', 'CopyObject', 'DeleteObject']);
    expect((s3Send.mock.calls[1][0] as { input: { CopySource: string } }).input.CopySource).toBe(
      'imgs/plants/h/p/a%20b.jpg'
    );
    expect(bucket.get('trash/plants/h/p/a b.jpg')).toBe('x');
  });

  it('is a no-op without a configured bucket', async () => {
    const trash = await import('../../../src/services/trashService.js');
    delete process.env.IMAGES_BUCKET;
    try {
      expect(await trash.moveImagePrefix('plants/', 'trash/plants/')).toBe(0);
      expect(s3Send).not.toHaveBeenCalled();
    } finally {
      process.env.IMAGES_BUCKET = 'imgs';
    }
  });
});
