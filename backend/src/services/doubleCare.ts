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
import { getHousehold } from './householdService.js';
import { hemisphereForLocation, resolveCadence, type Hemisphere } from './seasonalCadence.js';
import {
  CompletionLike,
  RecentDuplicate,
  ScheduleDrift,
  computeScheduleDrift,
  doubleCareWindowStart,
  pickRecentDuplicate,
  scheduleDriftScheduleUnavailable,
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

/** The task fields the drift path needs. */
type DriftTask = Pick<Task, 'id' | 'frequency' | 'seasonalCadences'>;

/** Whether a task carries a seasonal profile at all. */
const isSeasonal = (task: DriftTask) =>
  Boolean(task.seasonalCadences && task.seasonalCadences.length > 0);

/**
 * The household's hemisphere for the drift path — as a settled result, never
 * as a bare `Hemisphere | null`.
 *
 * `null` and "the read failed" are different answers and the drift math treats
 * them differently: a household with no location has a knowable scheduled
 * interval (the base frequency), and a household we could not read does not.
 * Collapsing the two here would publish `scheduledIntervalDays` as if it were
 * the interval in force when it might not be — ADR 0010's rule, on the value
 * a measurement is divided by.
 */
type HemisphereRead = { status: 'ok'; hemisphere: Hemisphere | null } | { status: 'unavailable' };

async function readHemisphere(householdId: string): Promise<HemisphereRead> {
  try {
    return {
      status: 'ok',
      hemisphere: hemisphereForLocation((await getHousehold(householdId))?.location),
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId },
      'schedule_drift_household_read_failed'
    );
    return { status: 'unavailable' };
  }
}

/**
 * The interval each task is actually scheduled at right now, or `null` for a
 * task whose interval could not be established.
 *
 * Drift is `(median actual − scheduled) / scheduled`, so a task with a
 * seasonal profile measured against its base `frequency` reports the
 * household's *correct* winter interval as a mistake — the app telling a
 * family that doing the right thing is drift. The household is read once for
 * the whole plant, and only when some task on it actually has a profile.
 *
 * KNOWN LIMIT, deliberately not papered over: the comparison is one median
 * against the cadence in force NOW. A history that spans a cadence change is
 * still compared against a single interval, so a household that switched to
 * its winter cadence last month can still show drift for a few weeks until the
 * window of considered completions catches up. Per-interval seasoning would
 * change what `medianIntervalDays` and `driftPct` mean on a published payload,
 * which is a bigger, separate decision than this one.
 */
async function scheduledIntervals(
  householdId: string,
  tasks: readonly DriftTask[]
): Promise<Map<string, number | null>> {
  const intervals = new Map<string, number | null>(tasks.map((task) => [task.id, task.frequency]));
  if (!tasks.some(isSeasonal)) return intervals;

  const read = await readHemisphere(householdId);
  for (const task of tasks) {
    if (!isSeasonal(task)) continue;
    intervals.set(
      task.id,
      read.status === 'ok'
        ? resolveCadence(task.frequency, task.seasonalCadences, read.hemisphere, new Date())
            .frequency
        : // Interval unknown. A seasonal task's base frequency is NOT a stand-in
          // for it, so the caller reports `schedule_unavailable` rather than a
          // number it would then divide by.
          null
    );
  }
  return intervals;
}

/**
 * Drift for every task of a plant from ONE partition read. A failed read
 * marks every task `history_unavailable` rather than reporting 0% drift.
 */
export async function getScheduleDriftForPlant(
  householdId: string,
  plantId: string,
  tasks: readonly DriftTask[]
): Promise<ScheduleDrift[]> {
  const scheduled = await scheduledIntervals(householdId, tasks);
  const intervalFor = (task: DriftTask) => scheduled.get(task.id) ?? null;

  let completions: CompletionLike[];
  try {
    completions = await readPlantCompletions(householdId, plantId);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, plantId },
      'schedule_drift_history_read_failed'
    );
    return tasks.map((task) => {
      const interval = intervalFor(task);
      return interval === null
        ? scheduleDriftScheduleUnavailable(task.id, task.frequency)
        : scheduleDriftUnavailable(task.id, interval);
    });
  }
  const byTask = new Map<string, CompletionLike[]>();
  for (const completion of completions) {
    const list = byTask.get(completion.taskId) ?? [];
    list.push(completion);
    byTask.set(completion.taskId, list);
  }
  return tasks.map((task) => {
    const interval = intervalFor(task);
    return interval === null
      ? scheduleDriftScheduleUnavailable(task.id, task.frequency)
      : computeScheduleDrift(task.id, interval, byTask.get(task.id) ?? []);
  });
}

/** Drift for a single task (the one-tap "match schedule" path recomputes it). */
export async function getScheduleDriftForTask(
  householdId: string,
  task: Pick<Task, 'id' | 'plantId' | 'frequency' | 'seasonalCadences'>
): Promise<ScheduleDrift> {
  const [drift] = await getScheduleDriftForPlant(householdId, task.plantId, [task]);
  return drift;
}
