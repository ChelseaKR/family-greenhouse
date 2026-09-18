/**
 * Writes a restore plan (models/householdArchive.ts) into a household (#669).
 *
 * ## Only into an empty household
 *
 * Version 1 never merges. The target must hold no plants (in any lifecycle
 * state), no tasks and no spaces, and must not already carry an import marker
 * for a different archive. The check reads the rows themselves, not a counter,
 * and the claim that follows is conditional on the active-plant counter being
 * what the check saw, so an "add plant" that lands between the two is caught.
 *
 * ## The marker, and why a retry is safe
 *
 * The claim writes the archive's digest onto the household's METADATA row
 * (`archiveImportDigest`, status `in_progress`). Every restored row has a
 * deterministic id (householdArchive.restoredId), and rows are written in
 * fixed-size transactions whose Puts are conditional on the row not existing.
 * So:
 *   - a second import of the same archive, after it finished, finds status
 *     `complete` and adds nothing;
 *   - an import that stopped part-way (a Lambda timeout, a throttle that
 *     outlasted its retries) can be run again with the same archive: chunks
 *     that landed are recognised by their conditional Puts failing and are
 *     skipped, the rest land, and nothing is written twice;
 *   - a different archive is refused, because the household is no longer
 *     empty.
 * Chunks are atomic, and chunk boundaries depend only on the archive (the plan
 * keeps the archive's order), so "this chunk's first row exists" means the
 * whole chunk landed. That is what lets the count of what landed be exact.
 *
 * ## The plan cap
 *
 * Every chunk that carries active plants also increments the METADATA
 * `plantCount` counter in the SAME transaction, conditional on the result
 * staying within the plan — the same atomic counter `plantService.createPlant`
 * uses, so an import can never slip past a cap that single-plant creation
 * enforces. The handler refuses an over-cap archive before any write; the
 * per-chunk condition is what holds if the household changes mid-import.
 */
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { Limit } from '../models/plans.js';
import type { ArchiveImportPlan } from '../models/householdArchive.js';
import type { DynamoDBItem, Plant, Task } from '../models/types.js';
import { peekSpeciesCached } from './enrichment.js';

/** Puts per plant transaction (+1 counter update = 50, of DynamoDB's 100). */
const PLANT_CHUNK = 49;
/** Puts per task transaction. */
const TASK_CHUNK = 50;
/** Attempts per chunk when DynamoDB reports a transaction conflict. */
const CHUNK_ATTEMPTS = 3;
/** Concurrent species-cache reads while resolving canonical names. */
const SPECIES_LOOKUP_CONCURRENCY = 10;

export type ImportMarkerStatus = 'in_progress' | 'complete';

export interface ImportMarker {
  digest: string;
  status: ImportMarkerStatus;
}

/** What the handler needs to know about the target before planning. */
export interface ImportTarget {
  /** METADATA's active-plant counter; null when it was never seeded (legacy row). */
  plantCount: number | null;
  marker: ImportMarker | null;
  /** True when any plant, task or space row exists. */
  hasData: boolean;
}

/**
 * Raised when the claim's condition fails: another import claimed the
 * household, or its active-plant counter moved since it was read. Call sites
 * match on `err.name` (the PlanLimitError convention).
 */
export class ImportClaimLostError extends Error {
  constructor() {
    super('The household changed while the import was being prepared');
    this.name = 'ImportClaimLostError';
  }
}

function metadataKey(householdId: string) {
  return { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' };
}

async function anyRowWithPrefix(householdId: string, prefix: string): Promise<boolean> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}`, ':sk': prefix },
      Limit: 1,
    })
  );
  // One item answers "is there any?". A page that came back empty but with a
  // continuation key has not answered it, so it counts as data: refusing a
  // restore into a household that might not be empty is the safe direction.
  return (result.Items ?? []).length > 0 || result.LastEvaluatedKey !== undefined;
}

/**
 * Read the target household's import state. A failed read throws — "could
 * not check" must never be read as "empty".
 */
export async function readImportTarget(householdId: string): Promise<ImportTarget> {
  const [meta, plants, tasks, spaces] = await Promise.all([
    dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: metadataKey(householdId) })),
    anyRowWithPrefix(householdId, 'PLANT#'),
    anyRowWithPrefix(householdId, 'TASK#'),
    anyRowWithPrefix(householdId, 'SPACE#'),
  ]);
  if (!meta.Item) {
    throw new Error(`Household ${householdId} not found`);
  }
  const item = meta.Item as Record<string, unknown>;
  const digest = item.archiveImportDigest;
  const status = item.archiveImportStatus;
  return {
    plantCount: typeof item.plantCount === 'number' ? item.plantCount : null,
    marker:
      typeof digest === 'string'
        ? { digest, status: status === 'complete' ? 'complete' : 'in_progress' }
        : null,
    hasData: plants || tasks || spaces,
  };
}

/**
 * The scientific name the server's OWN species cache holds for each catalog
 * id — never the archive's claim, since `canonicalSpecies` is what leaves the
 * app for integrations. Cache-only (`peekSpeciesCached`): no Perenual call, no
 * budget spent. An id the cache cannot answer maps to null, which is what
 * plant creation writes when the catalog cannot be consulted, and the plan
 * counts it as not restored.
 */
export async function resolveCanonicalSpecies(ids: number[]): Promise<Map<number, string | null>> {
  const resolved = new Map<number, string | null>();
  for (let i = 0; i < ids.length; i += SPECIES_LOOKUP_CONCURRENCY) {
    const batch = ids.slice(i, i + SPECIES_LOOKUP_CONCURRENCY);
    const peeks = await Promise.all(batch.map((id) => peekSpeciesCached(id)));
    batch.forEach((id, index) => {
      const peek = peeks[index];
      const name = peek.status === 'cached' ? peek.value?.scientificName?.trim() : undefined;
      resolved.set(id, name ? name : null);
    });
  }
  return resolved;
}

/**
 * Claim the household for this archive. A FRESH claim requires no marker at
 * all and the active-plant counter unchanged since `readImportTarget`; a
 * RESUME requires the marker to name this same archive.
 */
export async function claimImport(
  householdId: string,
  input: {
    digest: string;
    importerUserId: string;
    now: string;
    resume: boolean;
    seenPlantCount: number | null;
  }
): Promise<void> {
  const values: Record<string, unknown> = {
    ':digest': input.digest,
    ':inProgress': 'in_progress',
  };
  let update: string;
  let condition: string;
  if (input.resume) {
    update = 'SET archiveImportStatus = :inProgress';
    condition = 'attribute_exists(PK) AND archiveImportDigest = :digest';
  } else {
    update =
      'SET archiveImportDigest = :digest, archiveImportStatus = :inProgress, ' +
      'archiveImportStartedAt = :now, archiveImportedBy = :by';
    values[':now'] = input.now;
    values[':by'] = input.importerUserId;
    const counterUnchanged =
      input.seenPlantCount === null
        ? 'attribute_not_exists(plantCount)'
        : 'plantCount = :seenPlantCount';
    if (input.seenPlantCount !== null) values[':seenPlantCount'] = input.seenPlantCount;
    condition = `attribute_exists(PK) AND attribute_not_exists(archiveImportDigest) AND ${counterUnchanged}`;
  }
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: metadataKey(householdId),
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeValues: values,
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      throw new ImportClaimLostError();
    }
    throw err;
  }
}

function plantItem(householdId: string, plant: Plant): DynamoDBItem {
  // Exactly the row plantService.createPlant writes: keys, type, the Plant.
  return {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `PLANT#${plant.id}`,
    entityType: 'Plant',
    ...plant,
  };
}

function taskItem(householdId: string, task: Task): DynamoDBItem {
  // Exactly the row taskService.createTask writes, GSIs included, so the
  // due-date and assignee indexes see a restored task like any other.
  const item: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `TASK#${task.id}`,
    GSI1PK: `HOUSEHOLD#${householdId}`,
    GSI1SK: task.nextDue,
    entityType: 'Task',
    ...task,
  };
  if (task.assignedTo) {
    item.GSI2PK = `HOUSEHOLD#${householdId}#ASSIGNEE#${task.assignedTo}`;
    item.GSI2SK = task.nextDue;
  }
  return item;
}

type ChunkOutcome = 'written' | 'already_present' | 'refused' | 'failed';

type TransactItems = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>;

function cancellationReasons(err: unknown): Array<{ Code?: string }> {
  if (err instanceof Error && err.name === 'TransactionCanceledException') {
    return (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  }
  return [];
}

/**
 * Commit one chunk. `putCount` Puts come first; an optional counter Update is
 * last. A failed Put condition means this chunk landed on an earlier attempt;
 * a failed counter condition means the plan cap (or the claim) refused it.
 */
async function commitChunk(
  items: TransactItems,
  putCount: number,
  context: { householdId: string; kind: 'plant' | 'task'; offset: number }
): Promise<ChunkOutcome> {
  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
    try {
      await dynamodb.send(new TransactWriteCommand({ TransactItems: items }));
      return 'written';
    } catch (err) {
      const reasons = cancellationReasons(err);
      if (reasons.slice(0, putCount).some((r) => r.Code === 'ConditionalCheckFailed')) {
        return 'already_present';
      }
      if (reasons[putCount]?.Code === 'ConditionalCheckFailed') {
        return 'refused';
      }
      const conflict = reasons.some((r) => r.Code === 'TransactionConflict');
      if (conflict && attempt < CHUNK_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 100)));
        continue;
      }
      logger.error(
        { err: err instanceof Error ? err.message : String(err), ...context, attempt },
        'archive_import.chunk_failed'
      );
      return 'failed';
    }
  }
  return 'failed';
}

export interface ImportWriteResult {
  /** Rows written by this call. */
  written: { plants: number; tasks: number };
  /** Rows already in place from an earlier attempt at the same archive. */
  alreadyPresent: { plants: number; tasks: number };
  /** Why writing stopped early, or null when every row is in place. */
  stopped: null | 'plan_limit' | 'write_failed';
}

/**
 * Write every row of the plan, plants first (tasks point at them), stopping at
 * the first chunk that cannot land. Returns exactly what is in place.
 */
export async function writeImportPlan(
  householdId: string,
  plan: ArchiveImportPlan,
  opts: { maxPlants: Limit }
): Promise<ImportWriteResult> {
  const result: ImportWriteResult = {
    written: { plants: 0, tasks: 0 },
    alreadyPresent: { plants: 0, tasks: 0 },
    stopped: null,
  };

  for (let offset = 0; offset < plan.plants.length; offset += PLANT_CHUNK) {
    const chunk = plan.plants.slice(offset, offset + PLANT_CHUNK);
    const active = chunk.filter((p) => p.status === 'active').length;
    const items: TransactItems = chunk.map((plant) => ({
      Put: {
        TableName: TABLE_NAME,
        Item: plantItem(householdId, plant),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    }));
    if (active > 0) {
      // An unlimited cap (`null`, models/plans.ts) carries no condition and no
      // `:room` — DynamoDB rejects an unreferenced ExpressionAttributeValue.
      const room = opts.maxPlants === null ? null : opts.maxPlants - active;
      items.push({
        Update: {
          TableName: TABLE_NAME,
          Key: metadataKey(householdId),
          UpdateExpression: 'SET plantCount = if_not_exists(plantCount, :zero) + :n',
          ConditionExpression:
            room === null
              ? 'attribute_exists(PK) AND archiveImportDigest = :digest'
              : 'attribute_exists(PK) AND archiveImportDigest = :digest AND (attribute_not_exists(plantCount) OR plantCount <= :room)',
          ExpressionAttributeValues:
            room === null
              ? { ':zero': 0, ':n': active, ':digest': plan.digest }
              : { ':zero': 0, ':n': active, ':digest': plan.digest, ':room': room },
        },
      });
    }
    const outcome = await commitChunk(items, chunk.length, { householdId, kind: 'plant', offset });
    if (outcome === 'written') result.written.plants += chunk.length;
    else if (outcome === 'already_present') result.alreadyPresent.plants += chunk.length;
    else {
      result.stopped = outcome === 'refused' ? 'plan_limit' : 'write_failed';
      return result;
    }
  }

  for (let offset = 0; offset < plan.tasks.length; offset += TASK_CHUNK) {
    const chunk = plan.tasks.slice(offset, offset + TASK_CHUNK);
    const items = chunk.map((task) => ({
      Put: {
        TableName: TABLE_NAME,
        Item: taskItem(householdId, task),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    }));
    const outcome = await commitChunk(items, chunk.length, { householdId, kind: 'task', offset });
    if (outcome === 'written') result.written.tasks += chunk.length;
    else if (outcome === 'already_present') result.alreadyPresent.tasks += chunk.length;
    else {
      result.stopped = 'write_failed';
      return result;
    }
  }

  return result;
}

/**
 * Mark the import finished and give the household the archive's name. Runs
 * only once every row is in place, so `complete` is never recorded for an
 * import that did not finish.
 */
export async function completeImport(
  householdId: string,
  input: { digest: string; now: string; householdName: string; plants: number; tasks: number }
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: metadataKey(householdId),
      UpdateExpression:
        'SET archiveImportStatus = :complete, archiveImportCompletedAt = :now, ' +
        'archiveImportPlants = :plants, archiveImportTasks = :tasks, #name = :name',
      ConditionExpression: 'archiveImportDigest = :digest',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: {
        ':complete': 'complete',
        ':now': input.now,
        ':plants': input.plants,
        ':tasks': input.tasks,
        ':name': input.householdName,
        ':digest': input.digest,
      },
    })
  );
}
