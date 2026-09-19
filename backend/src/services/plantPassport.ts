/**
 * The plant passport's recipient half (#676) — the DynamoDB side. The frozen
 * summary's shape, its strict parser and the first note's composer live in
 * `models/plantPassport.ts`; read that first for what crosses to a stranger
 * and what never does.
 *
 * Two jobs:
 *
 *   1. `createPassportShare` derives the summary from the household's stored
 *      records and freezes it onto an ordinary 14-day cutting-share row (see
 *      `plantService.createPlantShare`). Nothing in the summary is read from a
 *      request: the plant, its tasks, its completions and its lineage are all
 *      looked up here by the caller's own household id.
 *
 *   2. `claimPassportImport` makes an import happen at most once per
 *      household per link. A double tap, a retried request or a replayed one
 *      must not leave the recipient with two copies, so before the plant is
 *      created the household writes a marker under its OWN partition
 *      (`HOUSEHOLD#{id}` / `PASSPORTIMPORT#{digest of the code}`), conditional
 *      on it not existing. The marker holds only the imported plant's id and
 *      expires with the link. It lives with the recipient (not in the sharer's
 *      partition), so it is swept with the recipient's household and never
 *      makes the sharer's row differ from a cutting link's.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { hashCapabilityToken } from '../utils/tokenHash.js';
import {
  PASSPORT_COMPLETIONS_READ,
  buildPassportSummary,
  type PassportSummary,
} from '../models/plantPassport.js';
import * as plantService from './plantService.js';
import * as taskService from './taskService.js';

const MARKER_SK_PREFIX = 'PASSPORTIMPORT#';
/** How long an import with no result yet is presumed to still be running. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Make a passport link for a plant: the summary, derived now from stored
 * records, frozen onto a fresh share row. Null when the plant is not in the
 * caller's household. A read that fails throws — a passport is never frozen
 * from a partial read, because a missing history would read as "never cared
 * for".
 */
export async function createPassportShare(
  householdId: string,
  plantId: string,
  userId: string,
  now: Date = new Date()
): Promise<plantService.PlantShare | null> {
  const plant = await plantService.getPlant(householdId, plantId);
  if (!plant) return null;

  const [tasks, completions, lineage] = await Promise.all([
    taskService.getTasksForPlant(householdId, plantId),
    taskService.getTaskCompletions(householdId, plantId, PASSPORT_COMPLETIONS_READ),
    plantService.getLineage(householdId, plantId, plant.parentPlantId),
  ]);

  const summary = buildPassportSummary({
    plant: { createdAt: plant.createdAt, speciesSource: plant.speciesSource },
    tasks,
    completions,
    completionsReadLimit: PASSPORT_COMPLETIONS_READ,
    lineage: { parentName: lineage.parent?.name ?? null, cuttingsTaken: lineage.children.length },
    now,
  });

  return plantService.createPlantShare(householdId, plantId, userId, { passport: summary });
}

export type PassportImportClaim =
  | { kind: 'claimed' }
  /** This household already imported this link. `plantId` is its copy, or
   *  null while that import is still in flight. */
  | { kind: 'already'; plantId: string | null };

function markerKey(householdId: string, code: string) {
  return {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `${MARKER_SK_PREFIX}${hashCapabilityToken('plantShare', code)}`,
  };
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/**
 * Take the once-per-household claim on a link. `expiresAt` is the link's own
 * expiry, so the marker is gone when the link is.
 *
 * A marker whose plant no longer exists (the household deleted its copy) does
 * not block: it is replaced, once, under a condition naming the stale plant id
 * so two concurrent replays cannot both take it over.
 */
export async function claimPassportImport(
  householdId: string,
  code: string,
  expiresAt: string,
  now: Date = new Date()
): Promise<PassportImportClaim> {
  const key = markerKey(householdId, code);
  const item = {
    ...key,
    entityType: 'PassportImport',
    householdId,
    claimedAt: now.toISOString(),
    ttl: Math.floor(new Date(expiresAt).getTime() / 1000),
  };

  // Twice at most: the second pass only exists for a marker that expired
  // between the failed Put and the read that followed it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await dynamodb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        })
      );
      return { kind: 'claimed' };
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }

    const existing = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: key, ConsistentRead: true })
    );
    if (!existing.Item) continue;

    const plantId = (existing.Item.plantId as string | undefined) ?? null;
    const claimedAt = String(existing.Item.claimedAt ?? '');
    // A plant that still exists means the first import finished. No plant id
    // yet means it is running, or was killed before it could say so: only an
    // unfinished claim older than STALE_CLAIM_MS is taken over.
    const takeOver = plantId
      ? (await plantService.getPlant(householdId, plantId)) === null
      : now.getTime() - new Date(claimedAt).getTime() > STALE_CLAIM_MS;
    if (!takeOver) return { kind: 'already', plantId };

    try {
      await dynamodb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: item,
          // Compare-and-swap on the exact stale record, so two concurrent
          // replays cannot both take it over.
          ConditionExpression: plantId
            ? 'plantId = :stale'
            : 'attribute_not_exists(plantId) AND claimedAt = :stale',
          ExpressionAttributeValues: { ':stale': plantId ?? claimedAt },
        })
      );
      return { kind: 'claimed' };
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
      return { kind: 'already', plantId: null };
    }
  }
  return { kind: 'already', plantId: null };
}

/** Record which plant the claim produced, so a replay can point at it. */
export async function recordPassportImport(
  householdId: string,
  code: string,
  plantId: string
): Promise<void> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: markerKey(householdId, code),
        UpdateExpression: 'SET plantId = :plantId',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':plantId': plantId },
      })
    );
  } catch (err) {
    // The plant exists and the import succeeded; only the pointer is missing.
    logger.warn({ err: (err as Error).message, householdId }, 'passport_import.record_failed');
  }
}

/** Give the claim back after a failed import, so the household can try again. */
export async function releasePassportImport(householdId: string, code: string): Promise<void> {
  try {
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: markerKey(householdId, code),
        // Only an unfinished claim: never delete the record of a finished one.
        ConditionExpression: 'attribute_not_exists(plantId)',
      })
    );
  } catch (err) {
    if (!isConditionFailure(err)) {
      logger.warn({ err: (err as Error).message, householdId }, 'passport_import.release_failed');
    }
  }
}

export type { PassportSummary };
