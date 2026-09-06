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
import type { BatchWriteCommandOutput, QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { atCap, type Limit } from '../models/plans.js';
import { Plant, PlantStatus, SpeciesSource, DynamoDBItem } from '../models/types.js';
import { CreatePlantInput, MovePlantsInput, UpdatePlantInput } from '../models/schemas.js';
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
  input: CreatePlantInput & {
    canonicalSpecies?: string | null;
    speciesSource?: SpeciesSource | null;
  },
  householdId: string,
  userId: string,
  maxPlants: Limit
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
    spaceId: input.spaceId ?? null,
    placementNote: input.placementNote || null,
    summerSpaceId: input.summerSpaceId ?? null,
    winterSpaceId: input.winterSpaceId ?? null,
    imageUrl: null,
    notes: input.notes || null,
    careRule: input.careRule || null,
    status: 'active',
    statusChangedAt: null,
    tags,
    perenualSpeciesId: input.perenualSpeciesId ?? null,
    canonicalSpecies: input.canonicalSpecies ?? null,
    // Provenance of `species`. Derived by the handler, never read off the
    // request body — see handlers/plants/handler.ts#deriveSpeciesSource.
    speciesSource: input.speciesSource ?? null,
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
    if (atCap(base, maxPlants)) {
      throw new PlanLimitError(`Plant limit of ${maxPlants} reached`);
    }
  }
  // An unlimited cap (`null`, models/plans.ts) carries no condition and no
  // `:max` value — DynamoDB rejects an unreferenced ExpressionAttributeValue.
  const capped = maxPlants !== null;

  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
              UpdateExpression: 'SET plantCount = if_not_exists(plantCount, :base) + :one',
              ConditionExpression: capped
                ? 'attribute_exists(PK) AND (attribute_not_exists(plantCount) OR plantCount < :max)'
                : 'attribute_exists(PK)',
              ExpressionAttributeValues: capped
                ? { ':base': base, ':one': 1, ':max': maxPlants }
                : { ':base': base, ':one': 1 },
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
    spaceId: (result.Item.spaceId as string | null | undefined) ?? null,
    placementNote: (result.Item.placementNote as string | null | undefined) ?? null,
    summerSpaceId: (result.Item.summerSpaceId as string | null | undefined) ?? null,
    winterSpaceId: (result.Item.winterSpaceId as string | null | undefined) ?? null,
    imageUrl: result.Item.imageUrl as string | null,
    notes: result.Item.notes as string | null,
    careRule: (result.Item.careRule as string | null | undefined) ?? null,
    status: (result.Item.status as PlantStatus | undefined) ?? 'active',
    statusChangedAt: (result.Item.statusChangedAt as string | null | undefined) ?? null,
    tags: (result.Item.tags as string[] | undefined) ?? [],
    perenualSpeciesId: (result.Item.perenualSpeciesId as number | undefined) ?? null,
    canonicalSpecies: (result.Item.canonicalSpecies as string | null | undefined) ?? null,
    speciesSource: (result.Item.speciesSource as SpeciesSource | null | undefined) ?? null,
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

/**
 * Follow DynamoDB pagination to exhaustion. A page count is not an item
 * count: DynamoDB can return a short page because of its 1 MB response limit,
 * so the former ten-page ceiling could truncate well below the Greenhouse
 * plan's supported 5,000 active plants (and below that again when historical
 * plants were present).
 */
async function queryAllPages(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey })
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

export async function getPlants(
  householdId: string,
  filter: PlantFilter = 'active'
): Promise<Plant[]> {
  const items = await queryAllPages({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `HOUSEHOLD#${householdId}`,
      ':sk': 'PLANT#',
    },
    Limit: MAX_QUERY_LIMIT,
  });

  return items
    .map((item) => ({
      id: item.id as string,
      householdId: item.householdId as string,
      name: item.name as string,
      species: item.species as string | null,
      location: item.location as string | null,
      spaceId: (item.spaceId as string | null | undefined) ?? null,
      placementNote: (item.placementNote as string | null | undefined) ?? null,
      summerSpaceId: (item.summerSpaceId as string | null | undefined) ?? null,
      winterSpaceId: (item.winterSpaceId as string | null | undefined) ?? null,
      imageUrl: item.imageUrl as string | null,
      notes: item.notes as string | null,
      careRule: (item.careRule as string | null | undefined) ?? null,
      status: (item.status as PlantStatus | undefined) ?? 'active',
      statusChangedAt: (item.statusChangedAt as string | null | undefined) ?? null,
      tags: (item.tags as string[] | undefined) ?? [],
      perenualSpeciesId: (item.perenualSpeciesId as number | undefined) ?? null,
      canonicalSpecies: (item.canonicalSpecies as string | null | undefined) ?? null,
      speciesSource: (item.speciesSource as SpeciesSource | null | undefined) ?? null,
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
  input: UpdatePlantInput & {
    canonicalSpecies?: string | null;
    speciesSource?: SpeciesSource | null;
  },
  maxPlants: Limit
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

  if (input.spaceId !== undefined) {
    updateExpressions.push('#spaceId = :spaceId');
    expressionAttributeNames['#spaceId'] = 'spaceId';
    expressionAttributeValues[':spaceId'] = input.spaceId;
  }

  if (input.placementNote !== undefined) {
    updateExpressions.push('#placementNote = :placementNote');
    expressionAttributeNames['#placementNote'] = 'placementNote';
    expressionAttributeValues[':placementNote'] = input.placementNote;
  }

  if (input.summerSpaceId !== undefined) {
    updateExpressions.push('#summerSpaceId = :summerSpaceId');
    expressionAttributeNames['#summerSpaceId'] = 'summerSpaceId';
    expressionAttributeValues[':summerSpaceId'] = input.summerSpaceId;
  }

  if (input.winterSpaceId !== undefined) {
    updateExpressions.push('#winterSpaceId = :winterSpaceId');
    expressionAttributeNames['#winterSpaceId'] = 'winterSpaceId';
    expressionAttributeValues[':winterSpaceId'] = input.winterSpaceId;
  }

  if (input.notes !== undefined) {
    updateExpressions.push('#notes = :notes');
    expressionAttributeNames['#notes'] = 'notes';
    expressionAttributeValues[':notes'] = input.notes;
  }

  if (input.careRule !== undefined) {
    // Already trimmed by the schema; an emptied field clears the rule (null)
    // so a blank never shows up as a rule at completion time.
    updateExpressions.push('#careRule = :careRule');
    expressionAttributeNames['#careRule'] = 'careRule';
    expressionAttributeValues[':careRule'] = input.careRule || null;
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

  if (input.canonicalSpecies !== undefined) {
    updateExpressions.push('#canonicalSpecies = :canonicalSpecies');
    expressionAttributeNames['#canonicalSpecies'] = 'canonicalSpecies';
    expressionAttributeValues[':canonicalSpecies'] = input.canonicalSpecies;
  }

  // `undefined` means "leave provenance alone" (the name did not change), and
  // is NOT the same as null. See handler#speciesSourceForUpdate.
  if (input.speciesSource !== undefined) {
    updateExpressions.push('#speciesSource = :speciesSource');
    expressionAttributeNames['#speciesSource'] = 'speciesSource';
    expressionAttributeValues[':speciesSource'] = input.speciesSource;
  }

  if (input.parentPlantId !== undefined) {
    // Lineage link: a uuid sets/replaces the parent, an explicit null
    // detaches. Validation (same household, not self) lives in the handler.
    updateExpressions.push('#parentPlantId = :parentPlantId');
    expressionAttributeNames['#parentPlantId'] = 'parentPlantId';
    expressionAttributeValues[':parentPlantId'] = input.parentPlantId;
  }

  const hasNonStatusUpdates = updateExpressions.length > 0;

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

  const plainUpdate = async (omitStatus = false): Promise<Plant | null> => {
    const effectiveExpressions = omitStatus
      ? updateExpressions.filter(
          (expression) =>
            expression !== '#status = :status' &&
            expression !== '#statusChangedAt = :statusChangedAt'
        )
      : updateExpressions;
    const effectiveNames = { ...expressionAttributeNames };
    const effectiveValues = { ...expressionAttributeValues };
    if (omitStatus) {
      delete effectiveNames['#status'];
      delete effectiveNames['#statusChangedAt'];
      delete effectiveValues[':status'];
      delete effectiveValues[':statusChangedAt'];
    }
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `PLANT#${plantId}`,
        },
        UpdateExpression: `SET ${effectiveExpressions.join(', ')}`,
        ExpressionAttributeNames: effectiveNames,
        ExpressionAttributeValues: effectiveValues,
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
      spaceId: (result.Attributes.spaceId as string | null | undefined) ?? null,
      placementNote: (result.Attributes.placementNote as string | null | undefined) ?? null,
      summerSpaceId: (result.Attributes.summerSpaceId as string | null | undefined) ?? null,
      winterSpaceId: (result.Attributes.winterSpaceId as string | null | undefined) ?? null,
      imageUrl: result.Attributes.imageUrl as string | null,
      notes: result.Attributes.notes as string | null,
      careRule: (result.Attributes.careRule as string | null | undefined) ?? null,
      status: (result.Attributes.status as PlantStatus | undefined) ?? 'active',
      statusChangedAt: (result.Attributes.statusChangedAt as string | null | undefined) ?? null,
      tags: (result.Attributes.tags as string[] | undefined) ?? [],
      perenualSpeciesId: (result.Attributes.perenualSpeciesId as number | undefined) ?? null,
      canonicalSpecies: (result.Attributes.canonicalSpecies as string | null | undefined) ?? null,
      speciesSource: (result.Attributes.speciesSource as SpeciesSource | null | undefined) ?? null,
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
  // leaving 'active' decrements, returning to 'active' increments.
  // Reactivation (delta===1) is cap-checked exactly like createPlant: die a
  // plant, create a replacement under the freed cap, then reactivate the
  // died one nets +1 active plant above the cap if left unchecked — a real
  // bypass introduced by the atomic counter (the old count-then-write check
  // recomputed the active count from scratch on every create, so nothing
  // could be "banked" this way).
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
      // A true status no-op is idempotent: don't falsify statusChangedAt or
      // updatedAt. If the request also edits ordinary fields, write those
      // fields while explicitly omitting the redundant lifecycle values.
      if (current.status === input.status) {
        return hasNonStatusUpdates ? plainUpdate(true) : current;
      }
      // A real non-active → non-active transition doesn't move the counter.
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
                // Reactivation (delta===1) is cap-checked, same as createPlant;
                // the decrement (delta===-1) is never capped — leaving 'active'
                // can only reduce the count.
                // An unlimited cap (`null`) carries no condition and no `:max`.
                ConditionExpression:
                  delta === 1 && maxPlants !== null
                    ? 'attribute_exists(PK) AND (attribute_not_exists(plantCount) OR plantCount < :max)'
                    : 'attribute_exists(PK)',
                ExpressionAttributeValues:
                  delta === 1
                    ? {
                        ':zero': 0,
                        ':one': 1,
                        ...(maxPlants !== null ? { ':max': maxPlants } : {}),
                      }
                    : { ':one': 1 },
              },
            },
          ],
        })
      );
    } catch (err) {
      const reasons = transactCancellationReasons(err);
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        // Concurrent status change beat us — re-read and retry once.
        continue;
      }
      if (delta === 1 && reasons[1]?.Code === 'ConditionalCheckFailed') {
        throw new PlanLimitError(`Plant limit of ${maxPlants} reached`);
      }
      throw err;
    }
    // TransactWrite can't return the new attributes; re-read for the caller.
    return getPlant(householdId, plantId);
  }
  throw new Error(`Concurrent status updates for plant ${plantId}; giving up`);
}

/** Move up to 50 plants as one all-or-nothing household-scoped write. */
export async function movePlants(householdId: string, input: MovePlantsInput): Promise<Plant[]> {
  const updatedAt = new Date().toISOString();
  const setPlacementNote = input.placementNote !== undefined;

  await dynamodb.send(
    new TransactWriteCommand({
      TransactItems: input.plantIds.map((plantId) => ({
        Update: {
          TableName: TABLE_NAME,
          Key: {
            PK: `HOUSEHOLD#${householdId}`,
            SK: `PLANT#${plantId}`,
          },
          UpdateExpression: setPlacementNote
            ? 'SET #spaceId = :spaceId, #placementNote = :placementNote, #updatedAt = :updatedAt'
            : 'SET #spaceId = :spaceId, #updatedAt = :updatedAt',
          ExpressionAttributeNames: {
            '#spaceId': 'spaceId',
            '#updatedAt': 'updatedAt',
            ...(setPlacementNote ? { '#placementNote': 'placementNote' } : {}),
          },
          ExpressionAttributeValues: {
            ':spaceId': input.spaceId,
            ':updatedAt': updatedAt,
            ...(setPlacementNote ? { ':placementNote': input.placementNote } : {}),
          },
          ConditionExpression: 'attribute_exists(PK)',
        },
      })),
    })
  );

  const moved = await Promise.all(input.plantIds.map((plantId) => getPlant(householdId, plantId)));
  return moved.filter((plant): plant is Plant => plant !== null);
}

/** `BatchWriteItem`'s per-request item limit. */
const BATCH_WRITE_MAX_ITEMS = 25;
/**
 * How many times one chunk is submitted before the cascade is called failed.
 *
 * Enough for the throttle this is actually for — a burst against an on-demand
 * table, which adaptive capacity absorbs in well under a second — without
 * turning a genuinely unavailable table into a Lambda that runs out its
 * timeout instead of reporting.
 */
const BATCH_WRITE_MAX_ATTEMPTS = 4;
/** First backoff step. Doubles per attempt, with full jitter. */
const BATCH_WRITE_RETRY_BASE_MS = 50;

/** Type of a `RequestItems` list, and of what comes back unprocessed. */
type PendingWrites = NonNullable<BatchWriteCommandOutput['UnprocessedItems']>[string];

function batchWriteRetryDelayMs(step: number): number {
  const ceiling = BATCH_WRITE_RETRY_BASE_MS * 2 ** (step - 1);
  // Full jitter: two erasures throttling at the same moment back off onto
  // different milliseconds instead of re-colliding in lockstep.
  return 1 + Math.floor(Math.random() * ceiling);
}

/**
 * Delete every key, resubmitting whatever DynamoDB declines.
 *
 * `BatchWriteItem` answers HTTP 200 with an `UnprocessedItems` map when it
 * throttles part of a batch — those deletes did not happen, and the SDK does
 * not resubmit them on the caller's behalf. This loop does, and then THROWS if
 * anything is still unprocessed.
 *
 * Throwing is the point. The caller must let it reach the client before the
 * plant row is deleted: a surviving `TaskCompletion` or `PlantPhoto` row under
 * `HOUSEHOLD#{id}#PLANT#{plantId}` becomes unreachable once the plant row is
 * gone — `accountCleanup.deleteAbandonedHouseholdData` never enumerates that
 * partition, and neither row type carries a `ttl`, so nothing else will ever
 * find it. On `DELETE /me` those rows are retained personal data (`uploadedBy`,
 * `caption`, the image URL) belonging to an erased account, and a 500 the
 * caller can retry is the only honest answer. Mirrors the S3 half of this same
 * cascade, which already fails on `DeleteObjects`' `Errors`.
 */
async function batchDeleteKeys(
  keys: Array<{ PK: string; SK: string }>,
  context: { householdId: string; plantId: string }
): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH_WRITE_MAX_ITEMS) {
    let pending: PendingWrites = keys
      .slice(i, i + BATCH_WRITE_MAX_ITEMS)
      .map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 1; attempt <= BATCH_WRITE_MAX_ATTEMPTS && pending.length > 0; attempt += 1) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, batchWriteRetryDelayMs(attempt - 1)));
      }
      const result = await dynamodb.send(
        new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending } })
      );
      const unprocessed = result.UnprocessedItems?.[TABLE_NAME] ?? [];
      if (unprocessed.length > 0) {
        logger.warn(
          { ...context, unprocessed: unprocessed.length, attempt },
          'plant.cascade_batch_unprocessed'
        );
      }
      pending = unprocessed;
    }
    if (pending.length > 0) {
      logger.error({ ...context, unprocessed: pending.length }, 'plant.cascade_incomplete');
      throw new Error(
        `Plant cascade left ${pending.length} row(s) unprocessed after ` +
          `${BATCH_WRITE_MAX_ATTEMPTS} attempts; the plant row was not deleted`
      );
    }
  }
}

export async function deletePlant(householdId: string, plantId: string): Promise<Plant | null> {
  // Cascade: collect all task rows for this plant and all completion rows under
  // the plant's completion partition; batch-delete in chunks of 25 (the
  // BatchWriteItem service limit), resubmitting anything DynamoDB declines and
  // failing loudly if it stays declined (see batchDeleteKeys). The plant row
  // itself is deleted last with ConditionExpression + ALL_OLD so we get a
  // single atomic "did it exist?" check + the deleted attributes back — saves
  // the handler a GetItem roundtrip and lets us return the plant data for
  // audit logging. Last is also what makes a failed cascade recoverable: the
  // plant row is what a retry finds its orphans through.
  const taskRows = await queryAllPages({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `HOUSEHOLD#${householdId}`,
      ':sk': 'TASK#',
    },
    Limit: MAX_QUERY_LIMIT,
  });
  const taskKeysForPlant = taskRows
    .filter((t) => t.plantId === plantId)
    .map((t) => ({ PK: t.PK as string, SK: t.SK as string }));

  // The plant-specific partition contains both completions and photo
  // timeline rows. Delete the whole partition, not just COMPLETION# rows, so
  // a hard delete (including solo-account erasure) cannot leave DDB photo
  // metadata behind.
  const plantPartitionRows = await queryAllPages({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
    },
    Limit: MAX_QUERY_LIMIT,
  });
  const plantPartitionKeys = plantPartitionRows.map((item) => ({
    PK: item.PK as string,
    SK: item.SK as string,
  }));

  const cascadeKeys = [...taskKeysForPlant, ...plantPartitionKeys];
  await batchDeleteKeys(cascadeKeys, { householdId, plantId });

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
        spaceId: (item.spaceId as string | null | undefined) ?? null,
        placementNote: (item.placementNote as string | null | undefined) ?? null,
        summerSpaceId: (item.summerSpaceId as string | null | undefined) ?? null,
        winterSpaceId: (item.winterSpaceId as string | null | undefined) ?? null,
        imageUrl: (item.imageUrl as string | null | undefined) ?? null,
        notes: (item.notes as string | null | undefined) ?? null,
        careRule: (item.careRule as string | null | undefined) ?? null,
        status: (item.status as PlantStatus | undefined) ?? 'active',
        statusChangedAt: (item.statusChangedAt as string | null | undefined) ?? null,
        tags: (item.tags as string[] | undefined) ?? [],
        perenualSpeciesId: (item.perenualSpeciesId as number | null | undefined) ?? null,
        canonicalSpecies: (item.canonicalSpecies as string | null | undefined) ?? null,
        speciesSource: (item.speciesSource as SpeciesSource | null | undefined) ?? null,
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
 * so we list-and-delete that prefix, paging through every object version.
 * Production enables bucket versioning: deleting only the current keys would
 * create delete markers while retaining the users' photo bytes as noncurrent
 * versions. Account and plant deletion are erasure operations, so versions
 * and delete markers must both be removed permanently.
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
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    do {
      const listed = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        })
      );
      const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].flatMap(
        (object) => {
          if (typeof object.Key !== 'string') return [];
          return [
            {
              Key: object.Key,
              ...(typeof object.VersionId === 'string' ? { VersionId: object.VersionId } : {}),
            },
          ];
        }
      );

      // DeleteObjects accepts at most 1000 identifiers; ListObjectVersions
      // already pages at 1000 combined versions/delete markers.
      if (objects.length > 0) {
        const deleted = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          })
        );
        if (deleted.Errors?.length) {
          throw new Error(`S3 rejected ${deleted.Errors.length} image version deletion(s)`);
        }
      }

      keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
      versionIdMarker = listed.IsTruncated ? listed.NextVersionIdMarker : undefined;
    } while (keyMarker || versionIdMarker);
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
  /** Present (true) when a plant sitter sent the photo through an Away Kit
   *  link; `sitterLinkId` names which link. Absent on member uploads. */
  viaSitter?: boolean;
  sitterLinkId?: string;
}

export interface AppendPlantPhotoOptions {
  /** Attribute the photo to a sitter link instead of a member. */
  viaSitter?: { linkId: string };
  /**
   * Default true: the plant row's primary `imageUrl` follows the newest
   * photo. Sitter uploads pass false — an unauthenticated writer may add to
   * the timeline but never replace the picture the household chose.
   */
  setPrimaryImage?: boolean;
}

/**
 * Append a photo to the plant's timeline AND (by default) atomically update
 * the primary `imageUrl` on the plant row. The plant row keeps tracking the
 * most-recent photo (so existing UI continues to work); the timeline keeps
 * history.
 */
export async function appendPlantPhoto(
  householdId: string,
  plantId: string,
  imageUrl: string,
  uploadedBy: string,
  caption: string | null = null,
  options: AppendPlantPhotoOptions = {}
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
    ...(options.viaSitter ? { viaSitter: true, sitterLinkId: options.viaSitter.linkId } : {}),
  };
  const photoItem: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
    SK: `PHOTO#${now.toISOString()}#${id}`,
    entityType: 'PlantPhoto',
    ...photo,
  };

  if (options.setPrimaryImage === false) {
    // Timeline-only write. The condition still ties the row to a live plant
    // — the plant item must exist — via the same key the transaction below
    // guards, so a photo can't be appended to a deleted plant.
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE_NAME, Item: photoItem } },
          {
            ConditionCheck: {
              TableName: TABLE_NAME,
              Key: { PK: `HOUSEHOLD#${householdId}`, SK: `PLANT#${plantId}` },
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
        ],
      })
    );
    return photo;
  }

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
    ...(item.viaSitter === true
      ? { viaSitter: true, sitterLinkId: item.sitterLinkId as string | undefined }
      : {}),
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
 * rather than a GSI lookup — a deliberate tradeoff: active households are
 * plan-capped and getPlants exhausts pagination, so one extra query is
 * predictable at current scale. If detail-page traffic or household sizes
 * ever make this hot, the scale fix is a sparse GSI on parentPlantId.
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
