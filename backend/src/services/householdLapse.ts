/**
 * Is this household drifting away, and can we actually tell?
 *
 * Nothing in the product could answer that. `grep -r 'dormant|inactive|lapsed'`
 * over `backend/src` returned only Stripe churn analytics, so "a household that
 * has stopped caring for its plants" was not a state the app could name — even
 * though it is the state the app treats worst (#478: the weekly digest sends
 * *because* something is overdue, so silence earns more mail, not less).
 *
 * This module answers the question and nothing else. It sends no email, writes
 * no row, and changes no behaviour. Deciding whether to contact a household
 * that has gone quiet — and what to say — is a decision about real people, and
 * it is deliberately NOT made here.
 *
 * ## The distinction this file exists to hold
 *
 * "We can see they stopped" and "we could not read their data" are different
 * answers, and collapsing them is this repo's named defect class (ADR 0010).
 * It bites unusually hard here: a failed completions query looks exactly like
 * a household that has completed nothing, so a careless version of this file
 * would classify every household as lapsing the day DynamoDB throttles.
 *
 * So every state below is explicit, and there are four of them where a naive
 * boolean would have one:
 *
 *   - `unavailable`  — a read failed, or could not be completed. Never
 *                      counted as lapsing, ever.
 *   - `never_active` — nobody has EVER completed a task here. A household four
 *                      days old has not lapsed; it has not started. The two
 *                      need different treatment and so they are different
 *                      states.
 *   - `idle`         — completions stopped, but nothing is overdue. The
 *                      household owes its plants nothing. Quiet is not a
 *                      problem.
 *   - `lapsing`      — completions stopped AND work is piling up.
 *
 * `active` is the fifth: somebody completed something recently.
 *
 * Two more traps are closed by the types rather than by care:
 *
 *   - A completion row whose `completedAt` does not parse yields
 *     `unavailable`, not "0 days ago" and not "no completions". We know a
 *     completion exists and do not know when it was.
 *   - The activity partition is scanned newest-first past non-completion rows
 *     (it carries `ActivityEvent`s too). Running out of PAGE BUDGET is not the
 *     same as running out of rows, so hitting the cap yields `unavailable`
 *     with its own reason. Only an exhausted partition may return "none".
 *
 * ## Cost
 *
 * One GSI1 query per call, page-capped, and — only on the `never_active`
 * branch — one GetItem for the household's creation date. The overdue side is
 * handed in by the caller, because the only caller (the weekly digest scan)
 * has already read it.
 */
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { AtRiskResult } from './digestReport.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a household must go without a single completed task before the
 * silence is treated as a signal rather than a busy fortnight.
 *
 * 21 days, from #478. It is deliberately longer than the weekly digest's
 * cadence — a household that skips two digests and then waters everything on
 * the third Sunday was never lapsing, and a threshold shorter than the
 * feedback loop would say otherwise.
 */
export const LAPSE_SILENCE_DAYS = 21;

/**
 * How much unfinished work has to be waiting alongside that silence.
 *
 * One. A household with nothing overdue is `idle`, not lapsing, however long
 * it has been quiet — and a floor above 1 would silently reclassify a small
 * household (three plants, one overdue) as fine. Where the useful line sits
 * for OUTREACH is a product question; this is the detection floor, and the
 * classification carries `atRiskPlants` so a caller can apply its own.
 */
export const LAPSE_MIN_AT_RISK_PLANTS = 1;

/** Rows per activity page. Matches `taskService`'s own query ceiling. */
const ACTIVITY_PAGE_LIMIT = 200;

/**
 * How many activity pages we will read looking for the newest completion.
 *
 * The partition is newest-first and mixes `TaskCompletion` with `ActivityEvent`
 * rows, so the completion we want is usually on page one. The cap exists so a
 * household with thousands of non-completion events cannot turn one
 * classification into an unbounded scan. Exhausting it is reported as
 * `completion_scan_incomplete` and NEVER as "they have never completed
 * anything" — that is the whole point of having a cap with a name.
 */
const MAX_ACTIVITY_PAGES = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EngagementUnavailableReason =
  /** The activity query threw. */
  | 'completions_read_failed'
  /** We ran out of page budget before finding a completion or the end. */
  | 'completion_scan_incomplete'
  /** A completion exists; its timestamp did not parse. */
  | 'completion_timestamp_unreadable'
  /** The caller could not tell us how much work is overdue. */
  | 'overdue_unreadable';

/** The newest completed task in a household, or an honest reason we don't know. */
export type LastCompletionRead =
  | { status: 'ok'; completedAt: string }
  /** The partition was read to its end and holds no completion at all. */
  | { status: 'none' }
  | { status: 'unavailable'; reason: EngagementUnavailableReason };

/**
 * How much care this household currently owes, as the caller already knows it.
 *
 * Handed in rather than re-read: `digest.digestHousehold` has the at-risk rows
 * in hand by the time it asks, and a second query for a number it is holding
 * would be pure cost. `unavailable` is a first-class member for the same
 * reason it is on `AtRiskResult` — a household whose overdue read failed
 * cannot be called lapsing.
 */
export type OverdueRead =
  | { status: 'ok'; atRiskPlants: number; oldestOverdueDays: number | null }
  | { status: 'unavailable' };

export type HouseholdEngagement =
  | { status: 'unavailable'; reason: EngagementUnavailableReason }
  | { status: 'active'; daysSinceLastCompletion: number; atRiskPlants: number }
  | {
      status: 'never_active';
      /** Null when the household row could not be read — never 0. */
      householdAgeDays: number | null;
      atRiskPlants: number;
    }
  | { status: 'idle'; daysSinceLastCompletion: number }
  | {
      status: 'lapsing';
      daysSinceLastCompletion: number;
      atRiskPlants: number;
      /** Null when no overdue row carried a readable due date. */
      oldestOverdueDays: number | null;
    };

export interface ClassifyEngagementInput {
  lastCompletion: LastCompletionRead;
  overdue: OverdueRead;
  /** When the household was created; see `HouseholdStartRead`. Only the
   *  `never_active` branch reads it, so callers may pass `{ status: 'missing' }`
   *  rather than paying for a lookup they will not use. */
  householdStart: HouseholdStartRead;
  now: Date;
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

/**
 * Whole days between `then` and `now`, or null when `then` did not parse.
 *
 * Clamped at zero: a stored timestamp in the future is a data problem, and the
 * honest reading of "completed at a moment we have not reached" is "recently",
 * not a negative age that would sort a household into silence it never had.
 */
function wholeDaysSince(then: string, now: Date): number | null {
  const parsed = Date.parse(then);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed) / DAY_MS));
}

/**
 * Turn the reads into one named state.
 *
 * Pure, and the definition of record: every threshold is applied here and
 * nowhere else, so a caller cannot accidentally invent a sixth state by
 * comparing numbers itself.
 *
 * Unavailability is checked first and in a fixed order — the completion read,
 * then the overdue read — so that a run where both failed reports the signal
 * this module is actually about rather than whichever branch happened to come
 * first.
 */
export function classifyEngagement(input: ClassifyEngagementInput): HouseholdEngagement {
  const { lastCompletion, overdue, householdStart, now } = input;

  if (lastCompletion.status === 'unavailable') {
    return { status: 'unavailable', reason: lastCompletion.reason };
  }
  if (overdue.status === 'unavailable') {
    return { status: 'unavailable', reason: 'overdue_unreadable' };
  }

  if (lastCompletion.status === 'none') {
    return {
      status: 'never_active',
      householdAgeDays:
        householdStart.status === 'ok' ? wholeDaysSince(householdStart.createdAt, now) : null,
      atRiskPlants: overdue.atRiskPlants,
    };
  }

  const days = wholeDaysSince(lastCompletion.completedAt, now);
  if (days === null) {
    // A completion we can see and cannot date. Not "0 days ago", which would
    // read as fully engaged, and not "none", which would read as never
    // started. Both of those are answers we do not have.
    return { status: 'unavailable', reason: 'completion_timestamp_unreadable' };
  }

  if (days < LAPSE_SILENCE_DAYS) {
    return { status: 'active', daysSinceLastCompletion: days, atRiskPlants: overdue.atRiskPlants };
  }
  if (overdue.atRiskPlants < LAPSE_MIN_AT_RISK_PLANTS) {
    return { status: 'idle', daysSinceLastCompletion: days };
  }
  return {
    status: 'lapsing',
    daysSinceLastCompletion: days,
    atRiskPlants: overdue.atRiskPlants,
    oldestOverdueDays: overdue.oldestOverdueDays,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The newest `TaskCompletion` in a household's activity partition.
 *
 * Newest-first with a page budget, paging past `ActivityEvent` rows the same
 * way `taskService.getHouseholdActivity` does — DynamoDB applies `Limit` before
 * our `entityType` filter, so one page can be all plant-added events and no
 * completions at all.
 *
 * Three outcomes, and the difference between them is the reason this function
 * exists rather than a `?? null`:
 *   - a completion → `ok`
 *   - the partition ran out with none in it → `none`
 *   - the page budget ran out first, or the query threw → `unavailable`
 */
export async function readLastCompletion(householdId: string): Promise<LastCompletionRead> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  try {
    for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
      const result = await dynamodb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#ACTIVITY` },
          ScanIndexForward: false,
          Limit: ACTIVITY_PAGE_LIMIT,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );
      for (const item of result.Items ?? []) {
        if (item.entityType !== 'TaskCompletion') continue;
        const completedAt: unknown = item.completedAt;
        // A completion row with no usable timestamp. Say we cannot date it
        // rather than skipping to an older row, which would report a stale
        // date as the newest one.
        if (typeof completedAt !== 'string' || completedAt === '') {
          return { status: 'unavailable', reason: 'completion_timestamp_unreadable' };
        }
        return { status: 'ok', completedAt };
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!exclusiveStartKey) return { status: 'none' };
    }
  } catch (err) {
    logger.warn(
      { householdId, err: (err as Error).message, msg: 'retention.completions_read_failed' },
      'retention.completions_read_failed'
    );
    return { status: 'unavailable', reason: 'completions_read_failed' };
  }
  // Budget exhausted with pages still to go. We did not look everywhere, so we
  // do not get to say there is nothing there.
  logger.warn(
    { householdId, pages: MAX_ACTIVITY_PAGES, msg: 'retention.completion_scan_incomplete' },
    'retention.completion_scan_incomplete'
  );
  return { status: 'unavailable', reason: 'completion_scan_incomplete' };
}

/**
 * When this household was created.
 *
 * Three outcomes, not two: `missing` is "the row carries no usable creation
 * date", `unavailable` is "the read failed". Both end up as
 * `householdAgeDays: null` in the classification — an age we do not have is
 * never 0, which describes a household created today — but they are different
 * facts and the call site logs which one it got, so a spike in failed reads is
 * visible instead of looking like a population of undated households.
 */
export type HouseholdStartRead =
  { status: 'ok'; createdAt: string } | { status: 'missing' } | { status: 'unavailable' };

export async function readHouseholdStart(householdId: string): Promise<HouseholdStartRead> {
  try {
    const result = await dynamodb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
        ProjectionExpression: 'createdAt',
      })
    );
    const createdAt: unknown = result.Item?.createdAt;
    if (typeof createdAt !== 'string' || createdAt === '') return { status: 'missing' };
    return { status: 'ok', createdAt };
  } catch (err) {
    logger.warn(
      { householdId, err: (err as Error).message, msg: 'retention.household_age_unreadable' },
      'retention.household_age_unreadable'
    );
    return { status: 'unavailable' };
  }
}

/**
 * Classify one household. The overdue side is supplied by the caller.
 *
 * The creation-date read happens ONLY on the `never_active` branch, which is
 * the only state it can refine — so the common case costs exactly one query.
 */
export async function readHouseholdEngagement(
  householdId: string,
  overdue: OverdueRead,
  now: Date = new Date()
): Promise<HouseholdEngagement> {
  const lastCompletion = await readLastCompletion(householdId);
  const householdStart: HouseholdStartRead =
    lastCompletion.status === 'none'
      ? await readHouseholdStart(householdId)
      : { status: 'missing' };
  if (lastCompletion.status === 'none' && householdStart.status !== 'ok') {
    // Explicit at the call site, per ADR 0010: the age collapses to null
    // either way, so the reason it collapsed has to be countable somewhere.
    logger.info(
      {
        householdId,
        householdStart: householdStart.status,
        msg: 'retention.household_age_unknown',
      },
      'retention.household_age_unknown'
    );
  }
  return classifyEngagement({ lastCompletion, overdue, householdStart, now });
}

/**
 * Adapt the weekly digest's at-risk read into the shape above.
 *
 * `AtRiskResult.rows` is one row per PLANT — `gatherAtRisk` keeps the
 * most-overdue task per plant and drops the rest — so the count is at-risk
 * plants, not overdue tasks, and the field is named for what it is. Getting
 * that wrong would not have failed anything; it would have quietly published a
 * plant count under a task label.
 *
 * `daysOverdue` is nullable on every row (an unreadable `nextDue`), so
 * `oldestOverdueDays` is null when NO row carried a readable one — never 0,
 * which describes a task that came due today.
 */
export function overdueFromAtRisk(atRisk: AtRiskResult): OverdueRead {
  if (atRisk.status !== 'ok') return { status: 'unavailable' };
  // `Number.isFinite`, not `!== null`: a row carrying `undefined` or `NaN`
  // would otherwise reach `Math.max` and publish `NaN` as an overdue age.
  const readable = atRisk.rows
    .map((row) => row.daysOverdue)
    .filter((days): days is number => typeof days === 'number' && Number.isFinite(days));
  return {
    status: 'ok',
    atRiskPlants: atRisk.rows.length,
    oldestOverdueDays: readable.length > 0 ? Math.max(...readable) : null,
  };
}

/**
 * Flatten a classification into log fields.
 *
 * The optional members are omitted rather than defaulted, so a CloudWatch
 * filter reading `$.daysSinceLastCompletion` cannot match a household we never
 * measured one for.
 */
export function engagementLogFields(
  engagement: HouseholdEngagement
): Record<string, string | number> {
  const fields: Record<string, string | number> = { engagement: engagement.status };
  if (engagement.status === 'unavailable') fields.engagementReason = engagement.reason;
  if ('daysSinceLastCompletion' in engagement) {
    fields.daysSinceLastCompletion = engagement.daysSinceLastCompletion;
  }
  if ('atRiskPlants' in engagement) fields.atRiskPlants = engagement.atRiskPlants;
  if (engagement.status === 'lapsing' && engagement.oldestOverdueDays !== null) {
    fields.oldestOverdueDays = engagement.oldestOverdueDays;
  }
  if (engagement.status === 'never_active' && engagement.householdAgeDays !== null) {
    fields.householdAgeDays = engagement.householdAgeDays;
  }
  return fields;
}
