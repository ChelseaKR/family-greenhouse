/**
 * DynamoDB-backed CRUD operations for plants. Plants are stored under their
 * household partition; deleting a plant cascades to its task and completion
 * rows via batched deletes.
 *
 * The S3 image upload flow lives next to this in `handlers/plants/handler.ts`
 * — this service only writes the image URL onto the plant row.
 */
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  BatchWriteCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { Plant, PlantStatus, DynamoDBItem } from '../models/types.js';
import { CreatePlantInput, UpdatePlantInput } from '../models/schemas.js';
import { optionalEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';

/**
 * Raised when a write would exceed the household's plan cap. Handlers map
 * this to the existing 402 upgrade response. Call sites check `err.name ===
 * 'PlanLimitError'` (not instanceof) so test automocks of this module stay
 * compatible.
 */
export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

/**
 * Pull the per-item CancellationReasons off a TransactWriteCommand failure.
 * Returns [] for anything that isn't a TransactionCanceledException, so
 * callers can index into it safely.
 */
function transactCancellationReasons(err: unknown): Array<{ Code?: string }> {
  if (err instanceof Error && err.name === 'TransactionCanceledException') {
    return (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  }
  return [];
}

export async function createPlant(
  input: CreatePlantInput,
  householdId: string,
  userId: string,
  maxPlants: number
): Promise<Plant> {
  const id = uuid();
  const now = new Date().toISOString();

  // Tags are normalized to lowercase + trimmed so "Succulent" and "succulent "
  // match the same bucket. Storage stays the user's chosen casing for display.
  const tags = (input.tags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
  const plant: Plant = {
    id,
    householdId,
    name: input.name,
    species: input.species || null,
    location: input.location || null,
    imageUrl: null,
    notes: input.notes || null,
    status: 'active',
    statusChangedAt: null,
    tags,
    perenualSpeciesId: input.perenualSpeciesId ?? null,
    // Propagation lineage — caller (handler) has already validated that the
    // parent exists in the same household.
    parentPlantId: input.parentPlantId ?? null,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
  };

  const item: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `PLANT#${id}`,
    entityType: 'Plant',
    ...plant,
  };

  // ---- Atomic plan-cap enforcement (replaces the old count-then-put) ----
  // The household METADATA row carries `plantCount`: the number of ACTIVE
  // plants — exactly the population the old getPlants()-based check counted.
  // The plant Put and a conditional counter increment ride in one
  // TransactWriteCommand, so two concurrent creates can never both slip
  // under the cap (the verified TOCTOU).
  //
  // Backfill design (chosen for simplicity): legacy METADATA rows predate
  // the counter. We read METADATA once per create; when `plantCount` is
  // absent we count active plants (paginated getPlants) and seed the counter
  // via `if_not_exists(plantCount, :base)` INSIDE the same transaction. The
  // condition tolerates the missing attribute, so seed + increment + cap
  // check still commit atomically — if a concurrent create seeds the counter
  // first, `if_not_exists` ignores our :base and the `plantCount < :max`
  // branch governs. The only non-atomic step is the pre-throw below when a
  // legacy household is already at cap, which exactly mirrors the
  // pre-counter behavior and runs at most once per household ever.
  const meta = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
    })
  );
  if (!meta.Item) {
    throw new Error(`Household ${householdId} not found`);
  }
  let base = 0;
  if (typeof meta.Item.plantCount !== 'number') {
    const active = await getPlants(householdId, 'active');
    base = active.length;
    if (base >= maxPlants) {
      throw new PlanLimitError(`Plant limit of ${maxPlants} reached`);
    }
  }

  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
              UpdateExpression: 'SET plantCount = if_not_exists(plantCount, :base) + :one',
              ConditionExpression:
                'attribute_exists(PK) AND (attribute_not_exists(plantCount) OR plantCount < :max)',
              ExpressionAttributeValues: { ':base': base, ':one': 1, ':max': maxPlants },
            },
          },
          { Put: { TableName: TABLE_NAME, Item: item } },
        ],
      })
    );
  } catch (err) {
    // Item 0 is the counter update — a ConditionalCheckFailed there means
    // the cap condition lost (the Put at item 1 carries no condition).
    if (transactCancellationReasons(err)[0]?.Code === 'ConditionalCheckFailed') {
      throw new PlanLimitError(`Plant limit of ${maxPlants} reached`);
    }
    throw err;
  }

  return plant;
}

export async function getPlant(householdId: string, plantId: string): Promise<Plant | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `PLANT#${plantId}`,
      },
    })
  );

  if (!result.Item) {
    return null;
  }

  return {
    id: result.Item.id as string,
    householdId: result.Item.householdId as string,
    name: result.Item.name as string,
    species: result.Item.species as string | null,
    location: result.Item.location as string | null,
    imageUrl: result.Item.imageUrl as string | null,
    notes: result.Item.notes as string | null,
    status: (result.Item.status as PlantStatus | undefined) ?? 'active',
    statusChangedAt: (result.Item.statusChangedAt as string | null | undefined) ?? null,
    tags: (result.Item.tags as string[] | undefined) ?? [],
    perenualSpeciesId: (result.Item.perenualSpeciesId as number | undefined) ?? null,
    parentPlantId: (result.Item.parentPlantId as string | null | undefined) ?? null,
    createdAt: result.Item.createdAt as string,
    createdBy: result.Item.createdBy as string,
    updatedAt: result.Item.updatedAt as string,
  };
}

// Soft cap on per-household reads. A real household will not have hundreds of
// plants/tasks; cap aggressively to keep Lambda memory bounded and to surface
// pagination needs early if a workload trends bigger.
export const MAX_QUERY_LIMIT = 200;

/**
 * List a household's plants, filtered by lifecycle.
 *   - 'active' (default): the plants being cared for — this is what the cap
 *     counts and the main list shows.
 *   - 'past': died + gave_away (the history view).
 *   - 'all': everything.
 * Filtering is in-memory; a household is capped well under MAX_QUERY_LIMIT.
 */
export type PlantFilter = 'active' | 'past' | 'all';

// Hard ceiling on pagination: 10 pages × 200 = 2,000 plants. Paid plans
// allow 500–5,000 plants, so the old single-page Limit:200 query silently
// truncated larger collections; the page ceiling still bounds Lambda memory.
const MAX_QUERY_PAGES = 10;

export async function getPlants(
  householdId: string,
  filter: PlantFilter = 'active'
): Promise<Plant[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}`,
          ':sk': 'PLANT#',
        },
        Limit: MAX_QUERY_LIMIT,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
  } while (exclusiveStartKey && pages < MAX_QUERY_PAGES);

  return items
    .map((item) => ({
      id: item.id as string,
      householdId: item.householdId as string,
      name: item.name as string,
      species: item.species as string | null,
      location: item.location as string | null,
      imageUrl: item.imageUrl as string | null,
      notes: item.notes as string | null,
      status: (item.status as PlantStatus | undefined) ?? 'active',
      statusChangedAt: (item.statusChangedAt as string | null | undefined) ?? null,
      tags: (item.tags as string[] | undefined) ?? [],
      perenualSpeciesId: (item.perenualSpeciesId as number | undefined) ?? null,
      parentPlantId: (item.parentPlantId as string | null | undefined) ?? null,
      createdAt: item.createdAt as string,
      createdBy: item.createdBy as string,
      updatedAt: item.updatedAt as string,
    }))
    .filter((p) => {
      if (filter === 'all') return true;
      if (filter === 'past') return p.status !== 'active';
      return p.status === 'active';
    });
}

export async function updatePlant(
  householdId: string,
  plantId: string,
  input: UpdatePlantInput
): Promise<Plant | null> {
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  if (input.name !== undefined) {
    updateExpressions.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = input.name;
  }

  if (input.species !== undefined) {
    updateExpressions.push('#species = :species');
    expressionAttributeNames['#species'] = 'species';
    expressionAttributeValues[':species'] = input.species;
  }

  if (input.location !== undefined) {
    updateExpressions.push('#location = :location');
    expressionAttributeNames['#location'] = 'location';
    expressionAttributeValues[':location'] = input.location;
  }

  if (input.notes !== undefined) {
    updateExpressions.push('#notes = :notes');
    expressionAttributeNames['#notes'] = 'notes';
    expressionAttributeValues[':notes'] = input.notes;
  }

  if (input.tags !== undefined) {
    const cleaned = (input.tags ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 10);
    updateExpressions.push('#tags = :tags');
    expressionAttributeNames['#tags'] = 'tags';
    expressionAttributeValues[':tags'] = cleaned;
  }

  if (input.perenualSpeciesId !== undefined) {
    updateExpressions.push('#perenualSpeciesId = :perenualSpeciesId');
    expressionAttributeNames['#perenualSpeciesId'] = 'perenualSpeciesId';
    expressionAttributeValues[':perenualSpeciesId'] = input.perenualSpeciesId;
  }

  if (input.parentPlantId !== undefined) {
    // Lineage link: a uuid sets/replaces the parent, an explicit null
    // detaches. Validation (same household, not self) lives in the handler.
    updateExpressions.push('#parentPlantId = :parentPlantId');
    expressionAttributeNames['#parentPlantId'] = 'parentPlantId';
    expressionAttributeValues[':parentPlantId'] = input.parentPlantId;
  }

  if (input.status !== undefined) {
    updateExpressions.push('#status = :status', '#statusChangedAt = :statusChangedAt');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeNames['#statusChangedAt'] = 'statusChangedAt';
    expressionAttributeValues[':status'] = input.status;
    expressionAttributeValues[':statusChangedAt'] = new Date().toISOString();
  }

  updateExpressions.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();

  const plainUpdate = async (): Promise<Plant | null> => {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `PLANT#${plantId}`,
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    if (!result.Attributes) {
      return null;
    }

    return {
      id: result.Attributes.id as string,
      householdId: result.Attributes.householdId as string,
      name: result.Attributes.name as string,
      species: result.Attributes.species as string | null,
      location: result.Attributes.location as string | null,
      imageUrl: result.Attributes.imageUrl as string | null,
      notes: result.Attributes.notes as string | null,
      status: (result.Attributes.status as PlantStatus | undefined) ?? 'active',
      statusChangedAt: (result.Attributes.statusChangedAt as string | null | undefined) ?? null,
      tags: (result.Attributes.tags as string[] | undefined) ?? [],
      perenualSpeciesId: (result.Attributes.perenualSpeciesId as number | undefined) ?? null,
      parentPlantId: (result.Attributes.parentPlantId as string | null | undefined) ?? null,
      createdAt: result.Attributes.createdAt as string,
      createdBy: result.Attributes.createdBy as string,
      updatedAt: result.Attributes.updatedAt as string,
    };
  };

  if (input.status === undefined) {
    return plainUpdate();
  }

  // Status transitions move the active-plant counter on the household
  // METADATA row (the plan cap counts ACTIVE plants — see createPlant):
  // leaving 'active' decrements, returning to 'active' increments. Note the
  // semantics are deliberately identical to the pre-counter cap check:
  // re-activating a plant is NOT cap-checked (it never was), it just makes
  // the counter reflect reality for the next create.
  //
  // The plant write and the counter move ride one TransactWriteCommand,
  // conditioned on the status we just read, so a concurrent transition can't
  // double-move the counter; if we lose that race we re-read and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await getPlant(householdId, plantId);
    if (!current) {
      return null;
    }
    const delta =
      current.status === 'active' && input.status !== 'active'
        ? -1
        : current.status !== 'active' && input.status === 'active'
          ? 1
          : 0;

    if (delta === 0) {
      // No counter movement (no-op re-set, or died <-> gave_away): same
      // single conditional update as the non-status path.
      return plainUpdate();
    }

    // Legacy plant rows may lack a status attribute entirely (they hydrate
    // to 'active'), so the "was active" condition must tolerate it missing.
    const statusCondition =
      current.status === 'active'
        ? '(attribute_not_exists(#status) OR #status = :oldStatus)'
        : '#status = :oldStatus';
    try {
      await dynamodb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE_NAME,
                Key: { PK: `HOUSEHOLD#${householdId}`, SK: `PLANT#${plantId}` },
                UpdateExpression: `SET ${updateExpressions.join(', ')}`,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: {
                  ...expressionAttributeValues,
                  ':oldStatus': current.status,
                },
                ConditionExpression: `attribute_exists(PK) AND ${statusCondition}`,
              },
            },
            {
              Update: {
                TableName: TABLE_NAME,
                Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
                // if_not_exists keeps legacy rows without the counter from
                // failing; the create-path backfill is what truly seeds it.
                UpdateExpression:
                  delta === 1
                    ? 'SET plantCount = if_not_exists(plantCount, :zero) + :one'
                    : 'SET plantCount = if_not_exists(plantCount, :one) - :one',
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeValues: delta === 1 ? { ':zero': 0, ':one': 1 } : { ':one': 1 },
              },
            },
          ],
        })
      );
    } catch (err) {
      if (transactCancellationReasons(err)[0]?.Code === 'ConditionalCheckFailed') {
        // Concurrent status change beat us — re-read and retry once.
        continue;
      }
      throw err;
    }
    // TransactWrite can't return the new attributes; re-read for the caller.
    return getPlant(householdId, plantId);
  }
  throw new Error(`Concurrent status updates for plant ${plantId}; giving up`);
}

export async function deletePlant(householdId: string, plantId: string): Promise<Plant | null> {
  // Cascade: collect all task rows for this plant and all completion rows under
  // the plant's completion partition; batch-delete in chunks of 25 (the
  // BatchWriteItem service limit). The plant row itself is deleted last with
  // ConditionExpression + ALL_OLD so we get a single atomic "did it exist?"
  // check + the deleted attributes back — saves the handler a GetItem
  // roundtrip and lets us return the plant data for audit logging.
  const taskRows = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'TASK#',
      },
    })
  );
  const taskKeysForPlant = (taskRows.Items ?? [])
    .filter((t) => t.plantId === plantId)
    .map((t) => ({ PK: t.PK as string, SK: t.SK as string }));

  const completionRows = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
        ':sk': 'COMPLETION#',
      },
    })
  );
  const completionKeys = (completionRows.Items ?? []).map((c) => ({
    PK: c.PK as string,
    SK: c.SK as string,
  }));

  const cascadeKeys = [...taskKeysForPlant, ...completionKeys];
  for (let i = 0; i < cascadeKeys.length; i += 25) {
    const chunk = cascadeKeys.slice(i, i + 25);
    await dynamodb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
        },
      })
    );
  }

  let deleted: Plant | null = null;
  try {
    const result = await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: `PLANT#${plantId}` },
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_OLD',
      })
    );
    if (result.Attributes) {
      const item = result.Attributes;
      deleted = {
        id: item.id as string,
        householdId: item.householdId as string,
        name: item.name as string,
        species: (item.species as string | null | undefined) ?? null,
        location: (item.location as string | null | undefined) ?? null,
        imageUrl: (item.imageUrl as string | null | undefined) ?? null,
        notes: (item.notes as string | null | undefined) ?? null,
        status: (item.status as PlantStatus | undefined) ?? 'active',
        statusChangedAt: (item.statusChangedAt as string | null | undefined) ?? null,
        tags: (item.tags as string[] | undefined) ?? [],
        perenualSpeciesId: (item.perenualSpeciesId as number | null | undefined) ?? null,
        parentPlantId: (item.parentPlantId as string | null | undefined) ?? null,
        createdAt: item.createdAt as string,
        createdBy: item.createdBy as string,
        updatedAt: item.updatedAt as string,
      };
    }
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Cascade already nuked the related rows for a plant that no longer
      // exists. Rare (TOCTOU between this call and a concurrent delete);
      // surface as 404 to the handler.
      return null;
    }
    throw err;
  }

  // Keep the active-plant counter (see createPlant) in step: a hard delete
  // of an ACTIVE plant frees a cap slot. Plants already 'died'/'gave_away'
  // left the counter when their status changed (updatePlant), so deleting
  // them must NOT decrement again.
  if (deleted && deleted.status === 'active') {
    await decrementActivePlantCount(householdId);
  }

  // Now that the DDB rows are gone, sweep the plant's uploaded images from S3.
  await deletePlantImages(householdId, plantId);

  return deleted;
}

/**
 * Best-effort, floored-at-zero decrement of the household's active-plant
 * counter. Runs AFTER the plant row is provably deleted (the delete needs
 * ReturnValues ALL_OLD, which TransactWriteCommand can't provide, so this
 * pair is not transactional). A ConditionalCheckFailed here means the
 * counter is already 0 (or the METADATA row is gone) — swallow it; any other
 * failure is logged but never turns a successful delete into a user-visible
 * error. Worst case on a crash between delete and decrement, the counter
 * over-counts by one and the cap is enforced one plant early.
 */
async function decrementActivePlantCount(householdId: string): Promise<void> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
        UpdateExpression: 'SET plantCount = if_not_exists(plantCount, :one) - :one',
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(plantCount) OR plantCount > :zero)',
        ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return; // floor at 0 / metadata row missing — nothing to decrement
    }
    logger.warn({ err: (err as Error).message, householdId }, 'plant.count_decrement_failed');
  }
}

/**
 * Best-effort removal of a plant's uploaded images from S3 when the plant is
 * deleted. Every object for a plant lives under the
 * `plants/{householdId}/{plantId}/` prefix (see `handlers/plants/handler.ts`),
 * so we list-and-delete that prefix, paging through results.
 *
 * Guarded on `IMAGES_BUCKET`: in local dev and tests the bucket isn't
 * configured, so this is a no-op. Failures are logged, never thrown — the
 * DynamoDB rows are already gone by the time we get here, so a failed image
 * cleanup must not turn a successful delete into a user-visible error. Any
 * objects orphaned by such a failure are swept by the bucket's lifecycle rule
 * (see `docs/production-checklist.md`).
 */
async function deletePlantImages(householdId: string, plantId: string): Promise<void> {
  const bucket = optionalEnv('IMAGES_BUCKET');
  if (!bucket) return;

  try {
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
    const prefix = `plants/${householdId}/${plantId}/`;
    let continuationToken: string | undefined;

    do {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string');

      // DeleteObjects accepts at most 1000 keys; ListObjectsV2 already pages at
      // 1000, so one delete per page stays within the limit.
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          })
        );
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, plantId },
      'plant.image_cleanup_failed'
    );
  }
}

export interface PlantPhoto {
  id: string;
  plantId: string;
  imageUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  caption: string | null;
}

/**
 * Append a photo to the plant's timeline AND atomically update the primary
 * `imageUrl` on the plant row. The plant row keeps tracking the most-recent
 * photo (so existing UI continues to work); the timeline keeps history.
 */
export async function appendPlantPhoto(
  householdId: string,
  plantId: string,
  imageUrl: string,
  uploadedBy: string,
  caption: string | null = null
): Promise<PlantPhoto> {
  const id = uuid();
  const now = new Date();
  const photo: PlantPhoto = {
    id,
    plantId,
    imageUrl,
    uploadedBy,
    uploadedAt: now.toISOString(),
    caption,
  };
  const photoItem: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
    SK: `PHOTO#${now.toISOString()}#${id}`,
    entityType: 'PlantPhoto',
    ...photo,
  };

  await dynamodb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: photoItem } },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: { PK: `HOUSEHOLD#${householdId}`, SK: `PLANT#${plantId}` },
            UpdateExpression: 'SET #imageUrl = :imageUrl, #updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#imageUrl': 'imageUrl',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':imageUrl': imageUrl,
              ':updatedAt': now.toISOString(),
            },
            ConditionExpression: 'attribute_exists(PK)',
          },
        },
      ],
    })
  );

  return photo;
}

export async function getPlantPhotos(
  householdId: string,
  plantId: string,
  limit = 30
): Promise<PlantPhoto[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
        ':sk': 'PHOTO#',
      },
      ScanIndexForward: false,
      Limit: Math.min(limit, 100),
    })
  );
  return (result.Items || []).map((item) => ({
    id: item.id as string,
    plantId: item.plantId as string,
    imageUrl: item.imageUrl as string,
    uploadedBy: item.uploadedBy as string,
    uploadedAt: item.uploadedAt as string,
    caption: (item.caption as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Propagation lineage
// ---------------------------------------------------------------------------

export interface PlantLineageEntry {
  id: string;
  name: string;
  status: PlantStatus;
}

export interface PlantLineage {
  /** The plant this one was cut from, if any (and if it still exists —
   *  lineage links survive parent deletion as dangling history). */
  parent?: PlantLineageEntry;
  /** Cuttings taken from this plant, oldest first. Died children are
   *  included on purpose — propagation history is the point. */
  children: Array<PlantLineageEntry & { createdAt: string }>;
}

/**
 * Assemble the lineage block for GET /plants/{id}.
 *
 * Children are found by filtering the household's full plant list for
 * `parentPlantId === plantId`. That's an O(household) read per detail view
 * rather than a GSI lookup — a deliberate tradeoff: households are capped
 * well under the paginated getPlants ceiling (2,000 rows), so one extra
 * query is cheap at current scale. If detail-page traffic or household
 * sizes ever make this hot, the scale fix is a sparse GSI on parentPlantId.
 */
export async function getLineage(
  householdId: string,
  plantId: string,
  parentPlantId: string | null | undefined
): Promise<PlantLineage> {
  const all = await getPlants(householdId, 'all');

  const lineage: PlantLineage = {
    children: all
      .filter((p) => p.parentPlantId === plantId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((p) => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt })),
  };

  if (parentPlantId) {
    const parent = all.find((p) => p.id === parentPlantId);
    if (parent) {
      lineage.parent = { id: parent.id, name: parent.name, status: parent.status };
    }
    // Parent hard-deleted since the cutting was taken → omit rather than
    // surface a dead link; the child keeps its parentPlantId as history.
  }

  return lineage;
}

// ---------------------------------------------------------------------------
// Cutting shares (household → household)
// ---------------------------------------------------------------------------

/** How long a share link stays redeemable. */
const SHARE_TTL_DAYS = 14;

export interface PlantShareSnapshot {
  name: string;
  species: string | null;
  notes: string | null;
  imageUrl: string | null;
  tags: string[];
}

export interface PlantShare {
  code: string;
  plantId: string;
  householdId: string;
  /**
   * Frozen copy of the plant card taken at share time. Sharing a SNAPSHOT
   * (not a live reference) means later edits or even deletion of the source
   * plant never break an already-shared link — the recipient sees the card
   * as it was when it was shared. (The imageUrl may stop resolving if the
   * source plant is hard-deleted and its S3 prefix swept; the preview just
   * falls back to the placeholder.)
   */
  plantSnapshot: PlantShareSnapshot;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Create a SHARE#{code} row for a plant (copies the INVITE#{code} pattern:
 * 32-hex-char code, DDB TTL sweep, defensive expiry check on read).
 * Returns null when the plant doesn't exist in the caller's household.
 */
export async function createPlantShare(
  householdId: string,
  plantId: string,
  userId: string
): Promise<PlantShare | null> {
  const plant = await getPlant(householdId, plantId);
  if (!plant) return null;

  // 32 hex chars (128 bits), same code shape + rationale as
  // householdService.createInvite.
  const code = uuid().replace(/-/g, '');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SHARE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const share: PlantShare = {
    code,
    plantId,
    householdId,
    plantSnapshot: {
      name: plant.name,
      species: plant.species,
      notes: plant.notes,
      imageUrl: plant.imageUrl,
      tags: plant.tags,
    },
    createdBy: userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const item: DynamoDBItem = {
    PK: `SHARE#${code}`,
    SK: 'METADATA',
    entityType: 'PlantShare',
    ...share,
    ttl: Math.floor(expiresAt.getTime() / 1000),
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return share;
}

/**
 * Look up a share by code; null for unknown or expired codes. DDB TTL
 * eventually deletes expired rows, but TTL sweeps lag by up to ~48h, so the
 * read path re-checks expiresAt (same defensive pattern as getInvite).
 *
 * NOTE: shares are deliberately multi-redeem within their TTL — a share
 * code is a cutting card to pass around the group chat, not a security
 * token, and the snapshot contains no PII beyond the plant card itself.
 */
export async function getPlantShare(code: string): Promise<PlantShare | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `SHARE#${code}`, SK: 'METADATA' },
    })
  );

  if (!result.Item) return null;

  const snapshot = (result.Item.plantSnapshot ?? {}) as Partial<PlantShareSnapshot>;
  const share: PlantShare = {
    code: result.Item.code as string,
    plantId: result.Item.plantId as string,
    householdId: result.Item.householdId as string,
    plantSnapshot: {
      name: (snapshot.name as string) ?? '',
      species: snapshot.species ?? null,
      notes: snapshot.notes ?? null,
      imageUrl: snapshot.imageUrl ?? null,
      tags: snapshot.tags ?? [],
    },
    createdBy: result.Item.createdBy as string,
    createdAt: result.Item.createdAt as string,
    expiresAt: result.Item.expiresAt as string,
  };

  if (new Date(share.expiresAt) < new Date()) {
    return null;
  }

  return share;
}
