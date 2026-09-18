/**
 * Household trash (#670): a deleted plant or task is kept for 30 days and can
 * be restored intact, then it is purged for good.
 *
 * ## Rows leave the live key space; nothing filters them out
 *
 * The obvious design is a `deletedAt` attribute plus an "exclude deleted"
 * predicate on every read. It fails OPEN: every read path in the product —
 * the plant list, the reminder scan, the ICS feed, the digest, the sitter,
 * kiosk and tag views, the public API, the export, the chat tools, the year
 * in review — would have to remember the predicate, and the one that forgot
 * would keep showing a deleted plant to somebody. This module instead MOVES
 * the rows out of the keys those reads use:
 *
 *   - the ROOT row (the `PLANT#{id}` / `TASK#{id}` item) becomes a manifest,
 *     `PK = HOUSEHOLD#{id}`, `SK = TRASH#PLANT#{plantId}` (or `TRASH#TASK#`),
 *     carrying the original item verbatim in `item`;
 *   - a plant's DEPENDENTS — its tasks, its per-plant partition (completions,
 *     photo timeline, anything else stored there), its printed plant tags and
 *     its cutting-share links — move under
 *     `PK = HOUSEHOLD#{id}#TRASH#PLANT#{plantId}`, each wrapped verbatim.
 *
 * Neither wrapper carries a top-level GSI key, so the rows drop out of GSI1
 * (due dates, the activity feed's completions, the tag and share listings)
 * and GSI2 (assignees) as well. A read that nobody thought about therefore
 * finds nothing: the fail-closed direction. Restore puts the original items
 * back byte-for-byte, index keys included, which is what "comes back intact"
 * means here.
 *
 * ## Order, and what a crash leaves behind
 *
 * Trash moves dependents FIRST and the root LAST, in one transaction with the
 * manifest — the same order `plantService.deletePlant` uses and for the same
 * reason: until the root moves, the plant is still there to retry through. A
 * sweep after the commit catches rows written in between (a completion or a
 * sitter photo landing mid-move).
 *
 * Restore moves the root FIRST (with the plan-cap counter and a `restoring`
 * mark on the manifest, atomically), then the images, then the dependents,
 * and deletes the manifest last. A crash part-way leaves the entry listed as
 * restoring; restoring it again, trashing the plant again, or the next purge
 * run all finish the job rather than duplicating it.
 *
 * ## Retention: purge job first, TTL and S3 lifecycle as backstops
 *
 * `purgeAfter` is 30 days after deletion and the daily purge
 * (`runTrashPurge`, on the digests Lambda's schedule) is what makes the
 * 30-day statement true. DynamoDB TTL is best-effort and can lag by days, so
 * the rows also carry `ttl` at 37 days and the images bucket expires the
 * `trash/` prefix at 37 days — both only there so that a purge job that stops
 * running cannot turn "30 days" into "forever".
 *
 * ## Images
 *
 * Plant photos are served PUBLICLY through CloudFront's `/plants/*`
 * behaviour, so a moved row alone would not make a photo disappear: its URL
 * would keep answering. Trashing a plant therefore moves its objects from
 * `plants/{household}/{plant}/` to `trash/plants/{household}/{plant}/`, which
 * nothing serves; restore moves them back to the same keys, so every stored
 * URL resolves again unchanged. Edge caches can hold an already-fetched image
 * for up to the images cache policy's TTL — the same exposure a hard delete
 * has always had.
 *
 * ## Erasure bypasses all of this
 *
 * `DELETE /me` must erase trashed rows too, and must not reach them through
 * the listing path (whose "hide expired" rule would skip rows mid-purge).
 * `purgeAllTrash` enumerates the manifests directly and ignores age;
 * `anonymizeUserInTrash` rewrites a departing member's identity inside the
 * wrapped items exactly as `accountCleanup.anonymizeUserInHousehold` does on
 * live rows, and drops trashed credentials they minted so a later restore
 * cannot revive a link #449 revoked.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { optionalEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { atCap, type Limit } from '../models/plans.js';
import * as plantService from './plantService.js';
import * as householdService from './householdService.js';
import * as scheduledFanOut from './scheduledFanOut.js';
import { LEGACY_SURFACES, classifyRow, rekeyedItem } from './tokenHashBackfill.js';

/** How long an item stays restorable. Stated in the DPIA retention table. */
export const TRASH_RETENTION_DAYS = 30;
/**
 * When DynamoDB TTL and the images bucket's `trash/` lifecycle rule remove
 * whatever the purge job did not. Must stay in step with the `expire-trash`
 * rule in infrastructure/modules/frontend/main.tf.
 */
export const TRASH_BACKSTOP_DAYS = 37;

/** Must match accountCleanup's pseudonym, so a trashed row anonymized here
 *  reads exactly like a live row anonymized there. Asserted by a test. */
export const DELETED_USER_ID = 'deleted-user';
export const DELETED_USER_NAME = 'Former member';

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrashKind = 'plant' | 'task';
export const TRASH_KINDS: readonly TrashKind[] = ['plant', 'task'];

export function isTrashKind(value: unknown): value is TrashKind {
  return value === 'plant' || value === 'task';
}

type Item = Record<string, unknown>;

export interface TrashActor {
  userId: string;
  name: string;
}

/** What a plant took into the trash with it, counted at the time. */
export interface TrashContents {
  tasks: number;
  photos: number;
  completions: number;
}

/**
 * The listing shape. Deliberately a projection: the manifest's `item` holds
 * the whole plant row (free-text notes included) and the dependents hold tag
 * tokens, so nothing here is ever spread from a stored row.
 */
export interface TrashEntrySummary {
  kind: TrashKind;
  id: string;
  /** Plant name, or a task's custom label / type. */
  name: string;
  /** Task entries only: the built-in type, so a client can translate it. */
  taskType: string | null;
  plantId: string | null;
  plantName: string | null;
  deletedAt: string;
  deletedByName: string;
  /** After this instant the entry can no longer be restored. */
  purgeAfter: string;
  contents: TrashContents | null;
  /** A restore started and did not finish; restoring again completes it. */
  restoring: boolean;
}

export interface PurgeCounts {
  plants: number;
  tasks: number;
  photos: number;
  completions: number;
  /** Tags, shares and any other per-plant rows. */
  otherRows: number;
  s3Objects: number;
}

export function emptyPurgeCounts(): PurgeCounts {
  return { plants: 0, tasks: 0, photos: 0, completions: 0, otherRows: 0, s3Objects: 0 };
}

function addCounts(into: PurgeCounts, from: PurgeCounts): void {
  into.plants += from.plants;
  into.tasks += from.tasks;
  into.photos += from.photos;
  into.completions += from.completions;
  into.otherRows += from.otherRows;
  into.s3Objects += from.s3Objects;
}

// ---------------------------------------------------------------------------
// Errors — handlers map on `err.name` (the repo's automock-safe convention)
// ---------------------------------------------------------------------------

/** No such entry in this household's trash. → 404 */
export class TrashEntryNotFoundError extends Error {
  constructor() {
    super('That item is not in the trash');
    this.name = 'TrashEntryNotFoundError';
  }
}

/** The 30 days are up; the purge job owns it now. → 410 */
export class TrashEntryExpiredError extends Error {
  constructor() {
    super(
      `That item was in the trash for more than ${TRASH_RETENTION_DAYS} days and is being deleted permanently.`
    );
    this.name = 'TrashEntryExpiredError';
  }
}

/** A task cannot come back without its plant. → 409 */
export class TrashRestoreBlockedError extends Error {
  readonly reason: 'plant_in_trash' | 'plant_gone';
  constructor(reason: 'plant_in_trash' | 'plant_gone', plantName: string | null) {
    const plant = plantName ? `“${plantName}”` : 'its plant';
    super(
      reason === 'plant_in_trash'
        ? `This task belongs to ${plant}, which is in the trash too. Restore the plant first.`
        : `This task belonged to ${plant}, which has been deleted permanently, so the task can’t come back.`
    );
    this.name = 'TrashRestoreBlockedError';
    this.reason = reason;
  }
}

/** Something already lives under the item's id, or a restore is mid-flight
 *  where a purge was asked for. → 409 */
export class TrashConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrashConflictError';
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function householdPk(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

function entrySk(kind: TrashKind, id: string): string {
  return `TRASH#${kind.toUpperCase()}#${id}`;
}

function entryKey(householdId: string, kind: TrashKind, id: string): { PK: string; SK: string } {
  return { PK: householdPk(householdId), SK: entrySk(kind, id) };
}

/** Where a trashed plant's dependents wait. */
export function dependentsPk(householdId: string, plantId: string): string {
  return `HOUSEHOLD#${householdId}#TRASH#PLANT#${plantId}`;
}

function rootKey(householdId: string, kind: TrashKind, id: string): { PK: string; SK: string } {
  return { PK: householdPk(householdId), SK: `${kind.toUpperCase()}#${id}` };
}

function liveImagePrefix(householdId: string, plantId: string): string {
  return `plants/${householdId}/${plantId}/`;
}

function trashImagePrefix(householdId: string, plantId: string): string {
  return `trash/${liveImagePrefix(householdId, plantId)}`;
}

function epochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** A stored attribute as a string, or `fallback` when it is not one. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Small DynamoDB helpers
// ---------------------------------------------------------------------------

async function queryAll(input: QueryCommandInput): Promise<Item[]> {
  const items: Item[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey })
    );
    items.push(...((result.Items ?? []) as Item[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

async function getConsistent(key: { PK: string; SK: string }): Promise<Item | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: key, ConsistentRead: true })
  );
  return (result.Item as Item | undefined) ?? null;
}

function cancellationReasons(err: unknown): Array<{ Code?: string }> {
  if (err instanceof Error && err.name === 'TransactionCanceledException') {
    return (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  }
  return [];
}

function keyOf(item: Item): { PK: string; SK: string } {
  return { PK: item.PK as string, SK: item.SK as string };
}

async function getEntryItem(
  householdId: string,
  kind: TrashKind,
  id: string
): Promise<Item | null> {
  return getConsistent(entryKey(householdId, kind, id));
}

/** Every manifest in the household, whatever its age. */
async function queryEntries(householdId: string): Promise<Item[]> {
  return queryAll({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': householdPk(householdId), ':sk': 'TRASH#' },
    ConsistentRead: true,
  });
}

async function queryDependents(householdId: string, plantId: string): Promise<Item[]> {
  return queryAll({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': dependentsPk(householdId, plantId) },
    ConsistentRead: true,
  });
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function isExpired(entry: Item, now: Date): boolean {
  const purgeAfter = Date.parse(str(entry.purgeAfter));
  // An unreadable date is treated as expired: the fail-closed direction for
  // something the household asked to be deleted.
  return !Number.isFinite(purgeAfter) || purgeAfter <= now.getTime();
}

function toSummary(entry: Item): TrashEntrySummary {
  const kind = entry.kind as TrashKind;
  const item = (entry.item ?? {}) as Item;
  const contents = entry.contents as TrashContents | undefined;
  return {
    kind,
    id: String(entry.itemId),
    name: str(entry.name),
    taskType: kind === 'task' ? ((item.type as string | undefined) ?? null) : null,
    plantId: (entry.plantId as string | null | undefined) ?? null,
    plantName: (entry.plantName as string | null | undefined) ?? null,
    deletedAt: String(entry.deletedAt),
    deletedByName: str(entry.deletedByName, DELETED_USER_NAME),
    purgeAfter: String(entry.purgeAfter),
    contents:
      kind === 'plant'
        ? {
            tasks: contents?.tasks ?? 0,
            photos: contents?.photos ?? 0,
            completions: contents?.completions ?? 0,
          }
        : null,
    restoring: entry.restoring === true,
  };
}

function countContents(rows: Item[]): TrashContents {
  const contents: TrashContents = { tasks: 0, photos: 0, completions: 0 };
  for (const row of rows) {
    if (row.entityType === 'Task') contents.tasks += 1;
    else if (row.entityType === 'PlantPhoto') contents.photos += 1;
    else if (row.entityType === 'TaskCompletion') contents.completions += 1;
  }
  return contents;
}

// ---------------------------------------------------------------------------
// Moving rows
// ---------------------------------------------------------------------------

/**
 * The form a row is kept in while it is in the trash.
 *
 * A plant tag or share link minted before tokens were hashed at rest (#450,
 * `tokenHashBackfill.ts`) is keyed by its PLAINTEXT token. The backfill finds
 * those rows by scanning the `PLANTTAG#` / `SHARE#` key prefixes, so a legacy
 * row wrapped in here would escape it and keep its plaintext at rest for the
 * whole trash window — and come back as a plaintext row on restore. So such a
 * row is re-keyed on the way in, with the backfill's own `classifyRow` /
 * `rekeyedItem` (which also drops a pre-#741 share's free-text notes): the
 * same token still resolves after a restore, through the hashed read.
 */
function atRestForm(row: Item): Item {
  for (const surface of [LEGACY_SURFACES.plantTag, LEGACY_SURFACES.plantShare]) {
    const classified = classifyRow(surface, row);
    if (classified.kind === 'legacy') return rekeyedItem(surface, row, classified.token);
  }
  return row;
}

function wrapDependent(householdId: string, plantId: string, row: Item, ttl: number): Item {
  const stored = atRestForm(row);
  return {
    PK: dependentsPk(householdId, plantId),
    // Built from the STORED key: a legacy row's own key is its plaintext.
    SK: `ROW#${String(stored.PK)}|${String(stored.SK)}`,
    entityType: 'TrashedRow',
    householdId,
    plantId,
    ttl,
    item: stored,
  };
}

/**
 * Everything that belongs to one live plant: its task rows, the whole
 * per-plant partition, and the tag + share credentials that point at it.
 *
 * The tag and share rows are found through GSI1, which is eventually
 * consistent, so each is re-read from the base table before it is snapshot —
 * a move must copy the row as it IS, not as the index last saw it.
 */
async function collectPlantDependents(householdId: string, plantId: string): Promise<Item[]> {
  const [tasks, partition, tagRefs, shareRefs] = await Promise.all([
    queryAll({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': householdPk(householdId), ':sk': 'TASK#' },
      ConsistentRead: true,
    }),
    queryAll({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}` },
      ConsistentRead: true,
    }),
    queryAll({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#PLANTTAG` },
    }),
    queryAll({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#SHARE` },
    }),
  ]);
  const credentialRefs = [...tagRefs, ...shareRefs].filter((ref) => ref.plantId === plantId);
  const credentials = await Promise.all(credentialRefs.map((ref) => getConsistent(keyOf(ref))));
  return [
    ...tasks.filter((task) => task.plantId === plantId),
    ...partition,
    ...credentials.filter(
      (row): row is Item =>
        row !== null && row.plantId === plantId && row.householdId === householdId
    ),
  ];
}

/** Copy every row into the plant's trash partition, THEN delete the
 *  originals — a failure in between leaves a duplicate, never a loss. */
async function moveIntoTrash(
  householdId: string,
  plantId: string,
  rows: Item[],
  ttl: number
): Promise<void> {
  if (rows.length === 0) return;
  const context = { householdId, plantId };
  await plantService.batchWriteWithRetry(
    rows.map((row) => ({ PutRequest: { Item: wrapDependent(householdId, plantId, row, ttl) } })),
    context
  );
  await plantService.batchDeleteKeys(rows.map(keyOf), context);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Move every CURRENT object under `fromPrefix` to the same relative key under
 * `toPrefix`. Idempotent: an object already moved is simply not listed. A
 * no-op returning 0 when `IMAGES_BUCKET` is unset (local dev, tests).
 *
 * Copy-then-delete, per object: a failure leaves the object in one place or
 * both, never neither. In the versioned production bucket the delete leaves a
 * noncurrent version behind, which the bucket's existing 30-day noncurrent
 * rule expires and a purge removes outright.
 */
export async function moveImagePrefix(fromPrefix: string, toPrefix: string): Promise<number> {
  const bucket = optionalEnv('IMAGES_BUCKET');
  if (!bucket) return 0;
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  let continuationToken: string | undefined;
  let moved = 0;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: fromPrefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const object of listed.Contents ?? []) {
      if (typeof object.Key !== 'string' || !object.Key.startsWith(fromPrefix)) continue;
      const destination = `${toPrefix}${object.Key.slice(fromPrefix.length)}`;
      await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: destination,
          CopySource: copySource(bucket, object.Key),
        })
      );
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      moved += 1;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return moved;
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/**
 * Move a plant, and everything that belongs to it, into the trash. Returns
 * null when there is no such live plant (→ 404).
 */
export async function trashPlant(
  householdId: string,
  plantId: string,
  actor: TrashActor,
  now: Date = new Date()
): Promise<TrashEntrySummary | null> {
  // A restore that crashed part-way leaves the root live and a manifest
  // marked `restoring`. Finish it before starting over, or this trash would
  // collide with the leftover manifest and strand the half-restored rows.
  const leftover = await getEntryItem(householdId, 'plant', plantId);
  if (leftover) {
    if (leftover.restoring !== true) return null; // already in the trash
    await completePlantRestore(householdId, plantId, now);
  }

  const root = await getConsistent(rootKey(householdId, 'plant', plantId));
  if (!root) return null;

  const deletedAt = now.toISOString();
  const purgeAfter = new Date(now.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString();
  const ttl = epochSeconds(now.getTime() + TRASH_BACKSTOP_DAYS * DAY_MS);

  const dependents = await collectPlantDependents(householdId, plantId);
  await moveIntoTrash(householdId, plantId, dependents, ttl);

  const manifest: Item = {
    ...entryKey(householdId, 'plant', plantId),
    entityType: 'TrashEntry',
    kind: 'plant',
    itemId: plantId,
    householdId,
    name: str(root.name),
    plantId,
    plantName: str(root.name),
    deletedAt,
    deletedBy: actor.userId,
    deletedByName: actor.name,
    purgeAfter,
    ttl,
    contents: countContents(dependents),
    item: root,
  };

  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: manifest,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: rootKey(householdId, 'plant', plantId),
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
        ],
      })
    );
  } catch (err) {
    if (cancellationReasons(err).length > 0) {
      // Deleted (or trashed) concurrently. The dependents this call moved are
      // the other call's dependents too; its commit owns them.
      return null;
    }
    throw err;
  }

  // Rows that landed between the collection and the commit — a completion
  // from a stale screen, a sitter photo — would otherwise outlive their plant.
  const late = await collectPlantDependents(householdId, plantId);
  if (late.length > 0) {
    await moveIntoTrash(householdId, plantId, late, ttl);
    logger.info({ householdId, plantId, rows: late.length }, 'trash.late_dependents_moved');
  }

  // Trashed plants do not count against the cap (the counter tracks ACTIVE
  // plants; a plant already archived left it at its status change).
  if ((root.status ?? 'active') === 'active') {
    await plantService.decrementActivePlantCount(householdId);
  }

  // Images last and best-effort: the plant is already gone from every read,
  // and the purge sweeps both prefixes whatever state this leaves.
  try {
    await moveImagePrefix(
      liveImagePrefix(householdId, plantId),
      trashImagePrefix(householdId, plantId)
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId, plantId }, 'trash.image_move_failed');
  }

  return toSummary(manifest);
}

/** Move one task into the trash. Returns null when there is no such live
 *  task (→ 404). Its past completions stay where they are, exactly as a
 *  task deletion always left them. */
export async function trashTask(
  householdId: string,
  taskId: string,
  actor: TrashActor,
  now: Date = new Date()
): Promise<TrashEntrySummary | null> {
  const root = await getConsistent(rootKey(householdId, 'task', taskId));
  if (!root) return null;
  const ttl = epochSeconds(now.getTime() + TRASH_BACKSTOP_DAYS * DAY_MS);
  const manifest: Item = {
    ...entryKey(householdId, 'task', taskId),
    entityType: 'TrashEntry',
    kind: 'task',
    itemId: taskId,
    householdId,
    name: str(root.customType) || str(root.type),
    plantId: str(root.plantId) || null,
    plantName: str(root.plantName) || null,
    deletedAt: now.toISOString(),
    deletedBy: actor.userId,
    deletedByName: actor.name,
    purgeAfter: new Date(now.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString(),
    ttl,
    item: root,
  };
  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: manifest,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: rootKey(householdId, 'task', taskId),
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
        ],
      })
    );
  } catch (err) {
    if (cancellationReasons(err).length > 0) return null;
    throw err;
  }
  return toSummary(manifest);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** One entry's summary, or null when it is not in the trash. */
export async function getEntry(
  householdId: string,
  kind: TrashKind,
  itemId: string
): Promise<TrashEntrySummary | null> {
  const entry = await getEntryItem(householdId, kind, itemId);
  return entry ? toSummary(entry) : null;
}

/** The household's restorable entries, newest deletion first. Entries past
 *  their window are awaiting the purge and are not offered for restore. */
export async function listTrash(
  householdId: string,
  now: Date = new Date()
): Promise<TrashEntrySummary[]> {
  const entries = await queryEntries(householdId);
  return entries
    .filter((entry) => isTrashKind(entry.kind))
    .filter((entry) => entry.restoring === true || !isExpired(entry, now))
    .map(toSummary)
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** The household's entitled plant cap, as `createPlant` receives it. */
  maxPlants: Limit;
}

/**
 * Bring an entry back. Throws TrashEntryNotFoundError / TrashEntryExpiredError
 * / TrashRestoreBlockedError / TrashConflictError, or plantService's
 * PlanLimitError when restoring an active plant would exceed the cap.
 */
export async function restoreEntry(
  householdId: string,
  kind: TrashKind,
  itemId: string,
  options: RestoreOptions,
  now: Date = new Date()
): Promise<TrashEntrySummary> {
  const entry = await getEntryItem(householdId, kind, itemId);
  if (!entry) throw new TrashEntryNotFoundError();
  if (entry.restoring !== true && isExpired(entry, now)) throw new TrashEntryExpiredError();
  const summary = toSummary(entry);
  if (kind === 'plant') {
    if (entry.restoring !== true) {
      await restorePlantRoot(householdId, itemId, entry, options.maxPlants);
    }
    await completePlantRestore(householdId, itemId, now);
  } else {
    await restoreTask(householdId, entry);
  }
  return { ...summary, restoring: false };
}

async function restorePlantRoot(
  householdId: string,
  plantId: string,
  entry: Item,
  maxPlants: Limit
): Promise<void> {
  const root = entry.item as Item;
  const countsAgainstCap = (root.status ?? 'active') === 'active';
  const capped = maxPlants !== null;
  let base = 0;

  if (countsAgainstCap) {
    // Same counter and the same legacy seeding as plantService.createPlant:
    // a household whose METADATA predates the counter is counted once.
    const meta = await getConsistent({ PK: householdPk(householdId), SK: 'METADATA' });
    if (!meta) throw new Error(`Household ${householdId} not found`);
    if (typeof meta.plantCount !== 'number') {
      base = (await plantService.getPlants(householdId, 'active')).length;
      if (atCap(base, maxPlants)) {
        throw new plantService.PlanLimitError(`Plant limit of ${maxPlants} reached`);
      }
    }
  }

  const transactItems: object[] = [];
  if (countsAgainstCap) {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: householdPk(householdId), SK: 'METADATA' },
        UpdateExpression: 'SET plantCount = if_not_exists(plantCount, :base) + :one',
        ConditionExpression: capped
          ? 'attribute_exists(PK) AND (attribute_not_exists(plantCount) OR plantCount < :max)'
          : 'attribute_exists(PK)',
        ExpressionAttributeValues: capped
          ? { ':base': base, ':one': 1, ':max': maxPlants }
          : { ':base': base, ':one': 1 },
      },
    });
  }
  const putIndex = transactItems.length;
  transactItems.push({
    Put: { TableName: TABLE_NAME, Item: root, ConditionExpression: 'attribute_not_exists(PK)' },
  });
  const markIndex = transactItems.length;
  transactItems.push({
    Update: {
      TableName: TABLE_NAME,
      Key: entryKey(householdId, 'plant', plantId),
      UpdateExpression: 'SET #restoring = :restoring',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#restoring': 'restoring' },
      ExpressionAttributeValues: { ':restoring': true },
    },
  });

  try {
    await dynamodb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    const reasons = cancellationReasons(err);
    if (reasons.length === 0) throw err;
    if (countsAgainstCap && reasons[0]?.Code === 'ConditionalCheckFailed') {
      throw new plantService.PlanLimitError(`Plant limit of ${maxPlants} reached`);
    }
    if (reasons[markIndex]?.Code === 'ConditionalCheckFailed') {
      // Restored or purged by someone else a moment ago.
      throw new TrashEntryNotFoundError();
    }
    if (reasons[putIndex]?.Code === 'ConditionalCheckFailed') {
      throw new TrashConflictError('A plant with this id already exists in the household.');
    }
    throw err;
  }
}

/**
 * The second half of a plant restore: images, then dependents, then the
 * manifest. Safe to run more than once; it is what a retry, a re-trash and
 * the purge job call on an entry left `restoring`.
 */
async function completePlantRestore(
  householdId: string,
  plantId: string,
  now: Date
): Promise<void> {
  // Images before history, so a restored timeline never points at objects
  // still sitting in trash/. A failure here throws and leaves the entry
  // listed as restoring; trying again picks up from this line.
  await moveImagePrefix(
    trashImagePrefix(householdId, plantId),
    liveImagePrefix(householdId, plantId)
  );

  const wrapped = await queryDependents(householdId, plantId);
  const memberIds = new Set(
    (await householdService.getHouseholdMembers(householdId)).map((member) => member.userId)
  );
  const restorable: Item[] = [];
  for (const row of wrapped) {
    const item = row.item as Item | undefined;
    if (!item || typeof item.PK !== 'string' || typeof item.SK !== 'string') continue;
    const prepared = prepareForRestore(item, memberIds, now);
    if (prepared) restorable.push(prepared);
  }
  const context = { householdId, plantId };
  await plantService.batchWriteWithRetry(
    restorable.map((item) => ({ PutRequest: { Item: item } })),
    context
  );
  await plantService.batchDeleteKeys(wrapped.map(keyOf), context);
  await dynamodb.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: entryKey(householdId, 'plant', plantId) })
  );
}

/**
 * The item to put back, or null when it must stay gone.
 *
 * - A tag or share link whose issuer is no longer a member is NOT revived.
 *   Removal revokes the credentials a departing member minted (#449); one
 *   that happened to be in the trash at the time must not come back through
 *   a restore. `anonymizeUserInTrash` drops them at departure too — this is
 *   the second lock on the same door.
 * - A share link past its own 14-day life stays gone rather than returning
 *   as a row the read path would refuse anyway.
 * - A task assigned to someone who has since left comes back unassigned,
 *   which is what their departure did to every live task.
 */
function prepareForRestore(item: Item, memberIds: Set<string>, now: Date): Item | null {
  if (item.entityType === 'PlantTag' || item.entityType === 'PlantShare') {
    if (typeof item.createdBy !== 'string' || !memberIds.has(item.createdBy)) return null;
    if (item.entityType === 'PlantShare') {
      const expiresAt = Date.parse(str(item.expiresAt));
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return null;
    }
    return item;
  }
  if (
    item.entityType === 'Task' &&
    typeof item.assignedTo === 'string' &&
    !memberIds.has(item.assignedTo)
  ) {
    return clearAssignment(item);
  }
  return item;
}

function clearAssignment(item: Item): Item {
  const next: Item = { ...item, assignedTo: null, assignedToName: null, assignmentSource: null };
  delete next.GSI2PK;
  delete next.GSI2SK;
  return next;
}

async function restoreTask(householdId: string, entry: Item): Promise<void> {
  const task = entry.item as Item;
  const plantId = typeof task.plantId === 'string' ? task.plantId : null;
  const plantName = (entry.plantName as string | null | undefined) ?? null;
  if (!plantId || !(await getConsistent(rootKey(householdId, 'plant', plantId)))) {
    const plantEntry = plantId ? await getEntryItem(householdId, 'plant', plantId) : null;
    throw new TrashRestoreBlockedError(plantEntry ? 'plant_in_trash' : 'plant_gone', plantName);
  }
  let restored = task;
  if (typeof task.assignedTo === 'string') {
    const member = await householdService.getMemberByUserId(householdId, task.assignedTo);
    if (!member) restored = clearAssignment(task);
  }
  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: restored,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: entryKey(householdId, 'task', String(entry.itemId)),
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
          {
            // The plant must still be there at commit, not just at the read.
            ConditionCheck: {
              TableName: TABLE_NAME,
              Key: rootKey(householdId, 'plant', plantId),
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
        ],
      })
    );
  } catch (err) {
    const reasons = cancellationReasons(err);
    if (reasons.length === 0) throw err;
    if (reasons[1]?.Code === 'ConditionalCheckFailed') throw new TrashEntryNotFoundError();
    if (reasons[2]?.Code === 'ConditionalCheckFailed') {
      throw new TrashRestoreBlockedError('plant_in_trash', plantName);
    }
    throw new TrashConflictError('A task with this id already exists in the household.');
  }
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

/**
 * Delete one entry for good. Returns null when there is no such entry.
 *
 * `erasure: true` is the `DELETE /me` path: it ignores a half-finished
 * restore (the household is being wiped, and the live root is deleted by the
 * caller's own cascade) instead of refusing.
 */
export async function purgeEntry(
  householdId: string,
  kind: TrashKind,
  itemId: string,
  options: { erasure?: boolean } = {}
): Promise<PurgeCounts | null> {
  const entry = await getEntryItem(householdId, kind, itemId);
  if (!entry) return null;
  const counts = emptyPurgeCounts();

  if (kind === 'plant') {
    const restoring = entry.restoring === true;
    if (restoring && !options.erasure) {
      throw new TrashConflictError(
        'This plant is part-way through being restored. Restore it again to finish, then delete it.'
      );
    }
    const wrapped = await queryDependents(householdId, itemId);
    for (const row of wrapped) {
      const type = (row.item as Item | undefined)?.entityType;
      if (type === 'Task') counts.tasks += 1;
      else if (type === 'PlantPhoto') counts.photos += 1;
      else if (type === 'TaskCompletion') counts.completions += 1;
      else counts.otherRows += 1;
    }
    // #603's retry-then-throw: a throttled batch is resubmitted, and one that
    // stays declined fails the purge with the manifest still in place, so the
    // next run finds and finishes it.
    await plantService.batchDeleteKeys(wrapped.map(keyOf), { householdId, plantId: itemId });

    // A task trashed on its own can never come back once its plant is gone.
    const orphans = (await queryEntries(householdId)).filter(
      (other) => other.kind === 'task' && other.plantId === itemId
    );
    for (const orphan of orphans) {
      await dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: keyOf(orphan) }));
      counts.tasks += 1;
    }

    const prefixes = [trashImagePrefix(householdId, itemId)];
    // The live prefix still holds the noncurrent versions the move left, but
    // mid-restore it holds the restored plant's CURRENT images — the live
    // root's own deletion sweeps those on the erasure path.
    if (!restoring) prefixes.push(liveImagePrefix(householdId, itemId));
    for (const prefix of prefixes) {
      try {
        counts.s3Objects += await plantService.deleteAllImageVersions(prefix);
      } catch (err) {
        // The bucket's `trash/` expiration and noncurrent-version rules are
        // the backstop; the rows are what a restore would need, and they go.
        logger.warn(
          { err: (err as Error).message, householdId, plantId: itemId, prefix },
          'trash.purge_image_cleanup_failed'
        );
      }
    }
    counts.plants += 1;
  } else {
    counts.tasks += 1;
  }

  await dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: keyOf(entry) }));
  return counts;
}

export interface HouseholdPurgeResult {
  counts: PurgeCounts;
  failed: number;
}

/**
 * Purge every entry past its window. Entries still inside it are untouched —
 * the job's whole contract is "only items past 30 days". An entry left
 * `restoring` is finished instead: its root is live, so the household chose
 * to keep it.
 */
export async function purgeExpired(
  householdId: string,
  now: Date = new Date()
): Promise<HouseholdPurgeResult> {
  const counts = emptyPurgeCounts();
  let failed = 0;
  const entries = (await queryEntries(householdId)).filter((entry) => isTrashKind(entry.kind));
  for (const entry of entries) {
    const kind = entry.kind as TrashKind;
    const itemId = String(entry.itemId);
    try {
      if (kind === 'plant' && entry.restoring === true) {
        await completePlantRestore(householdId, itemId, now);
        continue;
      }
      if (!isExpired(entry, now)) continue;
      const purged = await purgeEntry(householdId, kind, itemId);
      if (purged) addCounts(counts, purged);
    } catch (err) {
      failed += 1;
      logger.warn(
        { err: (err as Error).message, householdId, kind, itemId },
        'trash.purge_entry_failed'
      );
    }
  }
  return { counts, failed };
}

/** Erasure: every entry, whatever its age. Throws on the first failure so
 *  `DELETE /me` stops before deleting the login that could retry it. */
export async function purgeAllTrash(householdId: string): Promise<PurgeCounts> {
  const counts = emptyPurgeCounts();
  const entries = (await queryEntries(householdId)).filter((entry) => isTrashKind(entry.kind));
  // Plants first: purging a plant also removes its orphaned task entries.
  entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'plant' ? -1 : 1));
  for (const entry of entries) {
    const purged = await purgeEntry(householdId, entry.kind as TrashKind, String(entry.itemId), {
      erasure: true,
    });
    if (purged) addCounts(counts, purged);
  }
  return counts;
}

export interface TrashPurgeRunSummary {
  households: number;
  attempted: number;
  failed: number;
  truncated: boolean;
  purged: PurgeCounts;
}

/**
 * The daily job (digests Lambda, `{ "job": "trashPurge" }`). Walks every
 * household with the shared scheduled fan-out — bounded concurrency, a
 * deadline and a rotating start — and logs one `trash.purge_run_complete`
 * summary with per-kind counts, which the digests' failed/truncated metric
 * filters read.
 */
export async function runTrashPurge(
  now: Date = new Date(),
  options: { deadlineAt?: number } = {}
): Promise<TrashPurgeRunSummary> {
  const ids = await householdService.listAllHouseholdIds();
  const purged = emptyPurgeCounts();
  let failed = 0;
  const fanOut = await scheduledFanOut.fanOutHouseholds(
    'trashPurge',
    ids,
    async (householdId) => {
      try {
        const result = await purgeExpired(householdId, now);
        addCounts(purged, result.counts);
        failed += result.failed;
      } catch (err) {
        failed += 1;
        logger.warn({ err: (err as Error).message, householdId }, 'trash.purge_household_failed');
      }
    },
    { deadlineAt: options.deadlineAt }
  );
  const summary: TrashPurgeRunSummary = {
    households: fanOut.total,
    attempted: fanOut.attempted,
    failed,
    truncated: fanOut.truncated,
    purged,
  };
  logger.info({ ...summary, msg: 'trash.purge_run_complete' }, 'trash.purge_run_complete');
  return summary;
}

// ---------------------------------------------------------------------------
// Departure / account deletion
// ---------------------------------------------------------------------------

/**
 * Apply `accountCleanup.anonymizeUserInHousehold`'s rules to ONE wrapped
 * item. Returns the rewritten item, or null when nothing referenced the user.
 */
function anonymizeItem(item: Item, userId: string): Item | null {
  let next: Item = item;
  let changed = false;
  if (item.entityType === 'Task' && item.assignedTo === userId) {
    next = clearAssignment(next);
    changed = true;
  }
  const set = (attr: string, value: unknown): void => {
    if (!changed) next = { ...next };
    next[attr] = value;
    changed = true;
  };
  if (item.createdBy === userId) set('createdBy', DELETED_USER_ID);
  if (item.entityType === 'Task' && item.helpAskedBy === userId) {
    set('helpAskedBy', DELETED_USER_ID);
    set('helpAskedByName', DELETED_USER_NAME);
  }
  if (item.entityType === 'PlantPhoto' && item.uploadedBy === userId) {
    set('uploadedBy', DELETED_USER_ID);
  }
  if (item.entityType === 'TaskCompletion' && item.completedBy === userId) {
    set('completedBy', DELETED_USER_ID);
    set('completedByName', DELETED_USER_NAME);
  }
  return changed ? next : null;
}

/**
 * A member is leaving the household (removal, or account deletion in a
 * shared household): scrub them from what the trash holds, the same way
 * their live rows are scrubbed, and drop the tag/share credentials they
 * minted that are sitting in it.
 */
export async function anonymizeUserInTrash(householdId: string, userId: string): Promise<void> {
  const entries = (await queryEntries(householdId)).filter((entry) => isTrashKind(entry.kind));
  for (const entry of entries) {
    const rewrittenRoot = anonymizeItem((entry.item ?? {}) as Item, userId);
    const deletedByUser = entry.deletedBy === userId;
    if (rewrittenRoot || deletedByUser) {
      await dynamodb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            ...entry,
            ...(rewrittenRoot ? { item: rewrittenRoot } : {}),
            ...(deletedByUser
              ? { deletedBy: DELETED_USER_ID, deletedByName: DELETED_USER_NAME }
              : {}),
          },
          ConditionExpression: 'attribute_exists(PK)',
        })
      );
    }
    if (entry.kind !== 'plant') continue;
    for (const row of await queryDependents(householdId, String(entry.itemId))) {
      const item = (row.item ?? {}) as Item;
      const isCredential = item.entityType === 'PlantTag' || item.entityType === 'PlantShare';
      if (isCredential && item.createdBy === userId) {
        await dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: keyOf(row) }));
        continue;
      }
      const rewritten = anonymizeItem(item, userId);
      if (!rewritten) continue;
      await dynamodb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { ...row, item: rewritten },
          ConditionExpression: 'attribute_exists(PK)',
        })
      );
    }
  }
}
