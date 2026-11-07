/**
 * What a household did during its no-card trial, computed from rows that
 * already exist. No new tracking, no new writes.
 *
 *   - plants added: `PLANT#` rows on the household partition whose
 *     `createdAt` falls inside the trial window (any status, so a plant that
 *     was later archived still counts as added). A plant the household moved
 *     to the trash is gone from this partition and is not counted.
 *   - tasks done: `TaskCompletion` rows in the household's activity
 *     partition (GSI1) inside the window, not counting a double-care
 *     duplicate.
 *
 * ## Reminders delivered is deliberately NOT here
 *
 * The ask was plants, tasks and reminders delivered. Reminder delivery leaves
 * only `ReminderMarker` rows, and those carry a 48-hour DynamoDB TTL
 * (`MARKER_TTL_SECONDS` in `services/reminders.ts`), so a day-10 or day-14
 * read would see two days of them and call it the trial. Counting them would
 * be a plausible number detached from what happened, which is this repo's
 * named defect class (ADR 0010). It stays out until a durable record exists.
 *
 * ## Every count is a read that can fail
 *
 * `Read<number>` is `ok` or `unavailable`. A query that throws, or that has
 * more pages than the budget allows, is `unavailable` and the email omits the
 * line. It is never 0, because 0 is a claim ("you did nothing").
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { getHouseholdCounters } from './householdUsage.js';

export type CountRead = { status: 'ok'; value: number } | { status: 'unavailable' };

export interface TrialFacts {
  /** Plants added inside the trial window. */
  plantsAdded: CountRead;
  /** Care tasks marked done inside the trial window. */
  tasksCompleted: CountRead;
  /** Active plants right now, from the household counter. */
  plantsNow: CountRead;
  /** Members right now, from the household counter. */
  membersNow: CountRead;
}

/** Pages of 1 MB each. A household is far below this; hitting it is a
 *  reported unknown, not a count. */
const MAX_PAGES = 10;

async function countQuery(
  householdId: string,
  label: string,
  input: ConstructorParameters<typeof QueryCommand>[0]
): Promise<CountRead> {
  let total = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await dynamodb.send(
        new QueryCommand({ ...input, Select: 'COUNT', ExclusiveStartKey: exclusiveStartKey })
      );
      total += result.Count ?? 0;
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!exclusiveStartKey) return { status: 'ok', value: total };
    }
  } catch (err) {
    logger.warn(
      { householdId, err: (err as Error).message, msg: `trial_facts.${label}_read_failed` },
      `trial_facts.${label}_read_failed`
    );
    return { status: 'unavailable' };
  }
  logger.warn(
    { householdId, pages: MAX_PAGES, msg: `trial_facts.${label}_scan_incomplete` },
    `trial_facts.${label}_scan_incomplete`
  );
  return { status: 'unavailable' };
}

/**
 * Read the four facts. `windowStart` and `windowEnd` are ISO timestamps, and
 * the caller has already clamped `windowEnd` to the trial's end.
 */
export async function readTrialFacts(
  householdId: string,
  windowStart: string,
  windowEnd: string
): Promise<TrialFacts> {
  const [plantsAdded, tasksCompleted, counters] = await Promise.all([
    countQuery(householdId, 'plants', {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      FilterExpression: 'createdAt BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'PLANT#',
        ':from': windowStart,
        ':to': windowEnd,
      },
    }),
    countQuery(householdId, 'completions', {
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :from AND :to',
      FilterExpression:
        'entityType = :completion AND ' +
        '(attribute_not_exists(duplicateOfCompletionId) OR duplicateOfCompletionId = :none)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
        ':from': windowStart,
        ':to': windowEnd,
        ':completion': 'TaskCompletion',
        ':none': null,
      },
    }),
    getHouseholdCounters(householdId),
  ]);
  return {
    plantsAdded,
    tasksCompleted,
    plantsNow:
      counters.plantCount === null
        ? { status: 'unavailable' }
        : { status: 'ok', value: counters.plantCount },
    membersNow:
      counters.memberCount === null
        ? { status: 'unavailable' }
        : { status: 'ok', value: counters.memberCount },
  };
}
