/**
 * Double-care detection + schedule drift — the DynamoDB-backed half (the
 * arithmetic lives in `doubleCareRules.ts`). Every read here is a window or a
 * page over the completion log the household already writes, so the feature
 * costs $0 per household per month to serve.
 *
 * Failure posture: none of these reads may block care logging or publish a
 * fabricated answer. A failed read comes back as an explicit `unavailable`
 * status (or a `history_unavailable` reason) — never as "no duplicate", never
 * as zero.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { Task } from '../models/types.js';
import {
  CompletionLike,
  RecentDuplicate,
  ScheduleDrift,
  computeScheduleDrift,
  doubleCareWindowStart,
  pickRecentDuplicate,
  scheduleDriftUnavailable,
} from './doubleCareRules.js';

/** One page of a plant's completion partition is plenty for a window/rhythm. */
const PLANT_PAGE_LIMIT = 200;
const ACTIVITY_PAGE_LIMIT = 200;

export type DoubleCareCheck =
  | { status: 'clear' }
  | { status: 'duplicate'; duplicate: RecentDuplicate }
  | { status: 'unavailable' };

export type DoubleCareMonthly =
  | { status: 'ok'; month: string; confirmedDuplicates: number }
  | { status: 'unavailable' }
  | { status: 'not_in_plan' };

function itemToCompletion(item: Record<string, unknown>): CompletionLike {
  return {
    id: item.id as string,
    taskId: item.taskId as string,
    taskType: item.taskType as string,
    completedBy: item.completedBy as string,
    completedByName: (item.completedByName as string) ?? '',
    completedAt: item.completedAt as string,
    duplicateOfCompletionId: (item.duplicateOfCompletionId as string | null) ?? null,
  };
}

/**
 * Was this task — or this plant + care type — completed by another actor
 * inside the care type's window? One Query on the plant's completion
 * partition, bounded by the window's start.
 */
export async function findRecentDuplicate(input: {
  householdId: string;
  plantId: string;
  taskId: string;
  taskType: string;
  actorId: string;
  now?: Date;
}): Promise<DoubleCareCheck> {
  const now = input.now ?? new Date();
  try {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        // `COMPLETION#~` sorts after every `COMPLETION#<iso>#<uuid>` key ('~'
        // is the highest printable ASCII byte), so the range is "every
        // completion from the window's start onward".
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${input.householdId}#PLANT#${input.plantId}`,
          ':lo': `COMPLETION#${doubleCareWindowStart(input.taskType, now)}`,
          ':hi': 'COMPLETION#~',
        },
        ScanIndexForward: false,
        Limit: PLANT_PAGE_LIMIT,
      })
    );
    const duplicate = pickRecentDuplicate((result.Items ?? []).map(itemToCompletion), {
      taskId: input.taskId,
      taskType: input.taskType,
      actorId: input.actorId,
      now,
    });
    return duplicate ? { status: 'duplicate', duplicate } : { status: 'clear' };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId: input.householdId, taskId: input.taskId },
      'double_care_check_failed'
    );
    return { status: 'unavailable' };
  }
}

/**
 * Confirmed duplicates logged in the current UTC calendar month. Read from
 * the household activity partition (GSI1) the daily analytics already scan.
 */
export async function countConfirmedDuplicatesThisMonth(
  householdId: string,
  now: Date = new Date()
): Promise<DoubleCareMonthly> {
  const month = now.toISOString().slice(0, 7);
  const monthStart = `${month}-01T00:00:00.000Z`;
  try {
    let confirmedDuplicates = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await dynamodb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
            ':start': monthStart,
            ':end': now.toISOString(),
          },
          Limit: ACTIVITY_PAGE_LIMIT,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );
      for (const item of result.Items ?? []) {
        if (item.entityType !== 'TaskCompletion') continue;
        if (typeof item.duplicateOfCompletionId === 'string') confirmedDuplicates += 1;
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return { status: 'ok', month, confirmedDuplicates };
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'double_care_month_count_failed');
    return { status: 'unavailable' };
  }
}

/** Newest-first completions of one plant, one page. Throws on a failed read. */
async function readPlantCompletions(
  householdId: string,
  plantId: string
): Promise<CompletionLike[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
        ':sk': 'COMPLETION#',
      },
      ScanIndexForward: false,
      Limit: PLANT_PAGE_LIMIT,
    })
  );
  return (result.Items ?? []).map(itemToCompletion);
}

/**
 * Drift for every task of a plant from ONE partition read. A failed read
 * marks every task `history_unavailable` rather than reporting 0% drift.
 */
export async function getScheduleDriftForPlant(
  householdId: string,
  plantId: string,
  tasks: readonly Pick<Task, 'id' | 'frequency'>[]
): Promise<ScheduleDrift[]> {
  let completions: CompletionLike[];
  try {
    completions = await readPlantCompletions(householdId, plantId);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, plantId },
      'schedule_drift_history_read_failed'
    );
    return tasks.map((task) => scheduleDriftUnavailable(task.id, task.frequency));
  }
  const byTask = new Map<string, CompletionLike[]>();
  for (const completion of completions) {
    const list = byTask.get(completion.taskId) ?? [];
    list.push(completion);
    byTask.set(completion.taskId, list);
  }
  return tasks.map((task) =>
    computeScheduleDrift(task.id, task.frequency, byTask.get(task.id) ?? [])
  );
}

/** Drift for a single task (the one-tap "match schedule" path recomputes it). */
export async function getScheduleDriftForTask(
  householdId: string,
  task: Pick<Task, 'id' | 'plantId' | 'frequency'>
): Promise<ScheduleDrift> {
  const [drift] = await getScheduleDriftForPlant(householdId, task.plantId, [task]);
  return drift;
}
