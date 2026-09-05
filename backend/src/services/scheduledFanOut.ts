/**
 * Shared fan-out for the scheduled jobs that walk every household:
 * `reminders.remindAllHouseholds`, `digest.runWeeklyDigests`,
 * `digest.runYearRecaps` and `householdEmails.runHouseholdEmails`.
 *
 * ## What was wrong with a plain `for (const id of ids)`
 *
 * All four ran a serial loop with no clock in it, inside a 30-second Lambda
 * (`infrastructure/modules/api/main.tf`). Two consequences, and the second is
 * the one that hurt users:
 *
 *   1. Wall-clock scaled linearly with household count.
 *   2. When the wall clock ran past the timeout, the loop was killed WHEREVER
 *      it happened to be. The households after that point were simply not
 *      processed — and because EventBridge's retry restarts the handler from
 *      the beginning of the list, every retry died in the same place. The tail
 *      of the list was not "delayed", it was permanently unreachable, and
 *      which households sat in the tail was decided by DynamoDB's internal
 *      item order rather than by anything meaningful.
 *
 * ## What this does instead
 *
 * **Bounded concurrency.** Households are independent, so they are processed
 * `CONCURRENCY` at a time rather than one at a time. Same shape as
 * `accountCleanup.mapBounded`, and it is the whole reason the deadline below
 * is rarely reached.
 *
 * **A deadline, checked before each batch.** The caller passes the wall-clock
 * instant it must be finished by (derived from the Lambda's own remaining
 * time, so it tracks a timeout change in Terraform automatically). When the
 * deadline passes, the run STOPS rather than being killed.
 *
 * **A rotating start point.** The id the run stopped after is persisted, and
 * the next run starts at the household after it, wrapping around the end of
 * the list. So the tail is served by the next invocation instead of never.
 *
 * Rotation is deliberately a no-op when nothing is truncated: if a run gets
 * all the way round, every household was visited and only the ORDER differed.
 * That matters because the reminder path's per-recipient-local-day dedupe
 * (`services/reminders.ts`) and the digest's per-ISO-week dedupe
 * (`services/digest.ts`) both make a repeat visit cheap and harmless, but
 * neither of them makes a MISSED visit recoverable.
 *
 * Wrapping is also what keeps the weekly digest's four Monday runs meaning
 * what they meant before. That cadence exists so a recipient inside their
 * quiet hours at 00:00 UTC can be delivered at 06:00 instead. A resume that
 * only ever moved forwards would skip everyone the earlier run had already
 * visited-and-deferred, and they would get no digest at all that week.
 * Because the rotation wraps, run 2 finishes the tail and then comes back
 * round to the households run 1 deferred.
 *
 * ## Truncation must stay visible
 *
 * Before this, an over-long run showed up as a Lambda timeout, which is an
 * `Errors` data point, which the scheduled-function alarm added in #461 fires
 * on at `> 0`. Stopping cleanly and returning a summary would REMOVE that
 * signal — the same defect #461 fixed, re-created from the other side. So
 * `truncated` is carried out in the run summary, and
 * `infrastructure/modules/monitoring/main.tf` has a metric filter and an
 * alarm reading it. A run that cannot finish inside its budget is a capacity
 * problem someone has to see.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';

/**
 * Households processed at once. Each one is a handful of DynamoDB reads plus
 * per-member provider calls, so this is latency-bound, not CPU-bound — the
 * 256 MB these functions get is not the limit being worked around here.
 * Deliberately modest: the ceiling that matters is the shared SES/SNS send
 * rate, not the loop.
 */
export const FAN_OUT_CONCURRENCY = 5;

/** Reserved out of the Lambda's remaining time for the summary log line and
 *  the checkpoint write that follow the loop. */
const WIND_DOWN_MS = 3_000;

/** Used when a caller has no Lambda context to ask (local runs, the admin
 *  HTTP route, tests). Under the 30s configured for these functions. */
const FALLBACK_BUDGET_MS = 25_000;

/** Named so the checkpoint rows are greppable and can never collide with a
 *  household partition. */
export type ScheduledJob = 'reminders' | 'householdEmails' | 'weeklyDigest' | 'yearRecap';

export interface FanOutSummary {
  /** Households enumerated. Unchanged by truncation — it is the denominator
   *  that makes `attempted` readable. */
  total: number;
  /** Households actually visited this run. Equals `total` on a healthy run. */
  attempted: number;
  /** True when the run stopped on its deadline with households left. This is
   *  alarmed on; see the module note. */
  truncated: boolean;
}

/**
 * A deadline for one run, in wall-clock epoch milliseconds.
 *
 * `getRemainingTimeInMillis` is the Lambda context's own countdown, so a
 * Terraform timeout change moves this without anybody remembering to.
 * `share` splits one invocation's budget between two passes that ride the
 * same schedule (the reminder handler runs `remindAllHouseholds` and then
 * `runHouseholdEmails`); without it the first pass could consume the whole
 * invocation and the second would never run at all.
 */
export function deadlineFrom(
  context: { getRemainingTimeInMillis?: () => number } | undefined,
  share = 1,
  now: number = Date.now()
): number {
  const remaining = context?.getRemainingTimeInMillis?.() ?? FALLBACK_BUDGET_MS;
  const usable = Math.max(0, remaining - WIND_DOWN_MS);
  return now + usable * share;
}

function checkpointKey(job: ScheduledJob): { PK: string; SK: string } {
  return { PK: `SCHEDULED#${job}`, SK: 'CHECKPOINT' };
}

/**
 * Where the last run stopped.
 *
 * Three outcomes, kept apart (ADR 0010): a checkpoint we read, a run that has
 * never checkpointed, and a read that failed. The first two are both `ok` and
 * differ only in `lastHouseholdId`; the third is `unavailable` and the caller
 * decides what to do about it, out loud.
 *
 * They are separated even though the caller currently treats the last two the
 * same, because they are not the same fact: "no run has checkpointed yet" is a
 * fresh table, and "we could not read the checkpoint" is DynamoDB failing. A
 * single `null` for both would make a table whose checkpoint row is
 * permanently unreadable — so a run that permanently restarts at the top and
 * permanently strands the same tail — indistinguishable from a healthy first
 * run.
 */
export type CheckpointRead =
  { status: 'ok'; lastHouseholdId: string | null } | { status: 'unavailable' };

export async function readCheckpoint(job: ScheduledJob): Promise<CheckpointRead> {
  try {
    const result = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: checkpointKey(job) })
    );
    const id: unknown = result.Item?.lastHouseholdId;
    return { status: 'ok', lastHouseholdId: typeof id === 'string' && id !== '' ? id : null };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, job, msg: 'scheduled.checkpoint_read_failed' },
      'scheduled.checkpoint_read_failed'
    );
    return { status: 'unavailable' };
  }
}

/** Persist where this run stopped. Best-effort for the same reason as the
 *  read: a lost checkpoint degrades to "start from the top", never to a
 *  failed run. */
export async function writeCheckpoint(job: ScheduledJob, lastHouseholdId: string): Promise<void> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...checkpointKey(job),
          entityType: 'ScheduledCheckpoint',
          lastHouseholdId,
          updatedAt: new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, job, msg: 'scheduled.checkpoint_write_failed' },
      'scheduled.checkpoint_write_failed'
    );
  }
}

/**
 * Rotate `ids` so the element after `startAfterId` comes first.
 *
 * An id that is no longer in the list (household deleted since the last run)
 * rotates nothing, which starts from the top — the safe direction, because it
 * cannot skip anyone.
 */
export function rotateFrom(ids: readonly string[], startAfterId: string | null): string[] {
  if (!startAfterId) return [...ids];
  const at = ids.indexOf(startAfterId);
  if (at < 0) return [...ids];
  const from = (at + 1) % ids.length;
  return [...ids.slice(from), ...ids.slice(0, from)];
}

export interface FanOutOptions {
  /** Stop starting new work at this epoch-ms instant. Omit for no deadline —
   *  which is what the admin HTTP route and the unit tests want. */
  deadlineAt?: number;
  concurrency?: number;
  /** Injected by tests; real callers use the wall clock. */
  clock?: () => number;
}

/**
 * Run `handle` for every household id, newest-fairness first, stopping on the
 * deadline.
 *
 * `handle` owns its own error handling. That is not laziness: each caller
 * already counts failures into the `failed` field its metric filter reads
 * (`reminders.run_complete`, `digest.run_complete`, `recap.run_complete`), and
 * routing errors through here instead would have silently changed which log
 * message an alarm is built on. A `handle` that throws anyway is counted as a
 * visited household and re-thrown, so it cannot be lost either.
 */
export async function fanOutHouseholds(
  job: ScheduledJob,
  ids: readonly string[],
  handle: (householdId: string) => Promise<void>,
  options: FanOutOptions = {}
): Promise<FanOutSummary> {
  const clock = options.clock ?? Date.now;
  const concurrency = Math.max(1, options.concurrency ?? FAN_OUT_CONCURRENCY);
  // Fail-open, explicitly: an unreadable checkpoint starts the run at the top
  // of the list rather than aborting it. That direction is chosen because the
  // two mistakes are not symmetrical — starting too early re-visits households
  // whose per-day and per-week dedupe markers make the visit a cheap no-op,
  // while refusing to run leaves everyone unreminded. It is logged in
  // `readCheckpoint` and it is visible in the run summary, because a run that
  // keeps restarting at the top will keep reporting `truncated`.
  const checkpoint = await readCheckpoint(job);
  const order = rotateFrom(ids, checkpoint.status === 'ok' ? checkpoint.lastHouseholdId : null);

  let attempted = 0;
  let lastId: string | null = null;
  let truncated = false;

  for (let offset = 0; offset < order.length; offset += concurrency) {
    // Checked before the batch, never mid-batch: a household half-processed
    // is a household that may have reserved a delivery marker it will not
    // finalize. Whole batches only.
    if (options.deadlineAt !== undefined && clock() >= options.deadlineAt) {
      truncated = true;
      break;
    }
    const batch = order.slice(offset, offset + concurrency);
    await Promise.all(batch.map((id) => handle(id)));
    attempted += batch.length;
    lastId = batch[batch.length - 1] ?? lastId;
  }

  // Only when the run got somewhere. Writing on an empty run would pin the
  // rotation to a stale id forever.
  if (lastId !== null) await writeCheckpoint(job, lastId);

  if (truncated) {
    logger.warn(
      {
        job,
        total: ids.length,
        attempted,
        resumeAfter: lastId,
        msg: 'scheduled.run_truncated',
      },
      'scheduled.run_truncated'
    );
  }

  return { total: ids.length, attempted, truncated };
}
