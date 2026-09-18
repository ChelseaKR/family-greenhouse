/**
 * The hourly household chat-channel pass (#674). Rides the reminder Lambda's
 * schedule as its fourth pass (`handlers/reminders/handler.ts`), for the same
 * reasons the household-email and confirm-reminder passes do: no new
 * EventBridge rule, no new function in the deploy workflow's handler list,
 * and the function's existing error alarm and DLQ.
 *
 * Two posts, both household-level lists of plant care that name no person:
 *
 *   - `daily_due` — the morning list: every task due by the end of today in
 *     the channel's zone, or overdue (but not yet "resting", the reminder's
 *     own 14-day far edge), most urgent first. Once per channel-local day.
 *   - `up_for_grabs` — upcoming work nobody has claimed, due in (24h, 7d], the
 *     exact window the up-for-grabs EMAIL owns (`householdEmails`'s
 *     constants), so the channel never names a task the morning list already
 *     named. Once per ISO week.
 *
 * ## When (the #343 / #809 timing, applied to a channel)
 *
 * A channel has its own quiet hours and zone, set by the admin. Nothing is
 * posted inside them, and the daily list goes out at the first run at or
 * after their END — or 08:00 local with none set — through the very same
 * functions a member's reminder uses (`deliveryTime.isBeforeReminderDeliveryTime`,
 * `notificationPrefs.isInDndWindow`). The weekly post waits for the same
 * floor, so a Monday-morning up-for-grabs post never lands at 00:05.
 *
 * ## Once, and only once
 *
 * Each post reserves a marker before the network call and finalizes it only
 * when the platform accepts (`householdChannelStore.reservePost`), the lease
 * shape the reminder markers use. A retry of this pass — EventBridge's, or an
 * overlapping run — finds the marker and does not post again.
 *
 * ## Failure, honestly
 *
 * - A failed post releases its marker, is recorded against the channel, and
 *   ends this channel's turn for the hour (no second post into a webhook that
 *   just failed). Backoff and disabling are `householdChannel.failurePatch`.
 * - Tasks due but an EMPTY active-plant read is `unknown`, not "nothing to
 *   say" — the `upForGrabsHousehold` rule. Nothing is posted and nothing is
 *   marked, so the next hour looks again.
 * - A failed task read throws into the per-channel catch and is counted as
 *   `failed`, never summarised as a quiet hour.
 */
import type { Task } from '../models/types.js';
import type { HouseholdChannelRecord } from '../models/householdChannel.js';
import { logger } from '../utils/logger.js';
import * as taskService from './taskService.js';
import * as plantService from './plantService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as scheduledFanOut from './scheduledFanOut.js';
import { isBeforeReminderDeliveryTime, type QuietWindow } from './deliveryTime.js';
import { isDueByEndOfLocalDay, isRestingOverdue, dueStateFor, localDateKey } from './reminders.js';
import { taskLabelFor, type DueState } from './reminderEmail.js';
import {
  REMINDER_DUE_WINDOW_MS,
  UP_FOR_GRABS_LOOKAHEAD_MS,
  isoWeekKey,
} from './householdEmails.js';
import { composeDailyDue, composeUpForGrabs, type ChannelRow } from './channelMessages.js';
import * as store from './householdChannelStore.js';
import { attemptDelivery, recordOutcome, type DeliveryDeps } from './householdChannel.js';

const DUE_RANK: Record<DueState['kind'], number> = {
  overdue: 0,
  today: 1,
  upcoming: 2,
  unknown: 3,
};

function byUrgency(a: ChannelRow, b: ChannelRow): number {
  const rank = DUE_RANK[a.due.kind] - DUE_RANK[b.due.kind];
  if (rank !== 0) return rank;
  if (a.due.kind === 'overdue' && b.due.kind === 'overdue') return b.due.days - a.due.days;
  return (a.plantName ?? '').localeCompare(b.plantName ?? '');
}

/**
 * One task → one channel row. The ONLY place a `Task` becomes channel
 * content, and it copies four things by name: the plant's name (from the
 * active-plant read, not the task's denormalised copy), the task's label, its
 * due instant, and whether anyone is assigned. Notes, the assignee's identity
 * and every other field stay behind.
 */
export function channelRowFor(
  task: Task,
  activePlantNames: Map<string, string>,
  now: Date,
  locale: HouseholdChannelRecord['locale']
): ChannelRow {
  return {
    plantName: activePlantNames.get(task.plantId)?.trim() || null,
    taskLabel: taskLabelFor(task.type, task.customType, locale),
    due: dueStateFor(task.nextDue, now),
    unclaimed: !task.assignedTo,
    nextDue: task.nextDue,
  };
}

/** The morning list's rows: due by the end of the channel's today, or overdue
 *  and not yet resting. */
export function dailyDueRows(
  tasks: Task[],
  activePlantNames: Map<string, string>,
  now: Date,
  timeZone: string,
  locale: HouseholdChannelRecord['locale']
): ChannelRow[] {
  return tasks
    .filter((t) => activePlantNames.has(t.plantId))
    .filter((t) => isDueByEndOfLocalDay(t.nextDue, now, timeZone))
    .filter((t) => !isRestingOverdue(t.nextDue, now))
    .map((t) => channelRowFor(t, activePlantNames, now, locale))
    .sort(byUrgency);
}

/** The weekly post's rows: unassigned, due in (24h, 7d], soonest first. */
export function upForGrabsRows(
  tasks: Task[],
  activePlantNames: Map<string, string>,
  now: Date,
  locale: HouseholdChannelRecord['locale']
): ChannelRow[] {
  const edge = new Date(now.getTime() + REMINDER_DUE_WINDOW_MS).toISOString();
  const horizon = new Date(now.getTime() + UP_FOR_GRABS_LOOKAHEAD_MS).toISOString();
  return tasks
    .filter((t) => activePlantNames.has(t.plantId))
    .filter((t) => !t.assignedTo && t.nextDue > edge && t.nextDue <= horizon)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
    .map((t) => channelRowFor(t, activePlantNames, now, locale));
}

function quietWindow(record: HouseholdChannelRecord): QuietWindow {
  return { dndStart: record.quietStart, dndEnd: record.quietEnd, timezone: record.timezone };
}

export type ChannelVisit =
  | 'posted'
  | 'nothing_due'
  | 'held'
  | 'backing_off'
  | 'disabled'
  | 'already_posted'
  | 'unknown'
  | 'failed_delivery';

interface Gathered {
  status: 'ok' | 'unknown';
  tasks: Task[];
  activePlantNames: Map<string, string>;
}

async function gather(householdId: string, now: Date): Promise<Gathered> {
  const horizon = new Date(now.getTime() + UP_FOR_GRABS_LOOKAHEAD_MS).toISOString();
  const tasks = await taskService.getTasksDueBy(householdId, horizon);
  const activePlantNames = new Map<string, string>();
  if (tasks.length === 0) return { status: 'ok', tasks, activePlantNames };
  for (const plant of await plantService.getPlants(householdId)) {
    activePlantNames.set(plant.id, plant.name);
  }
  // Tasks but no active plants: a read we cannot tell apart from a short
  // one. Not "nothing to say" (see the module header).
  if (activePlantNames.size === 0) return { status: 'unknown', tasks, activePlantNames };
  return { status: 'ok', tasks, activePlantNames };
}

/**
 * Visit one channel. Throws only on a failed read, which the pass counts.
 * Exported for the tests; `runHouseholdChannels` is the real caller.
 */
export async function visitChannel(
  record: HouseholdChannelRecord,
  now: Date,
  deps?: DeliveryDeps
): Promise<ChannelVisit> {
  if (record.status === 'disabled') return 'disabled';
  if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now.getTime()) {
    return 'backing_off';
  }
  const window = quietWindow(record);
  if (notificationPrefs.isInDndWindow(window, now) || isBeforeReminderDeliveryTime(window, now)) {
    return 'held';
  }

  const pending: Array<{ kind: store.ChannelPostKind; periodKey: string }> = [];
  if (record.events.dailyDue) {
    const periodKey = localDateKey(now, record.timezone);
    if (!(await store.postAlreadyHandled(record.householdId, 'daily_due', periodKey, now))) {
      pending.push({ kind: 'daily_due', periodKey });
    }
  }
  if (record.events.upForGrabs) {
    const periodKey = isoWeekKey(now);
    if (!(await store.postAlreadyHandled(record.householdId, 'up_for_grabs', periodKey, now))) {
      pending.push({ kind: 'up_for_grabs', periodKey });
    }
  }
  if (pending.length === 0) return 'already_posted';

  const gathered = await gather(record.householdId, now);
  if (gathered.status === 'unknown') {
    logger.warn(
      {
        householdId: record.householdId,
        tasks: gathered.tasks.length,
        msg: 'household_channel.active_plants_empty',
      },
      'household_channel.active_plants_empty'
    );
    return 'unknown';
  }

  let posted = false;
  for (const { kind, periodKey } of pending) {
    const message =
      kind === 'daily_due'
        ? composeDailyDue(
            dailyDueRows(
              gathered.tasks,
              gathered.activePlantNames,
              now,
              record.timezone,
              record.locale
            ),
            record.locale
          )
        : composeUpForGrabs(
            upForGrabsRows(gathered.tasks, gathered.activePlantNames, now, record.locale),
            record.locale,
            record.timezone
          );
    // Nothing to say is not a post and not a marker: a task added later
    // today is still named on a later run of the same day.
    if (!message) continue;

    const reservationId = await store.reservePost(record.householdId, kind, periodKey, now);
    if (!reservationId) continue;

    const attempt = await attemptDelivery(record, message, deps);
    if (attempt.ok) {
      await store
        .finalizePost(record.householdId, kind, periodKey, reservationId, now)
        .catch((err) => {
          // The platform ACCEPTED the post. Never release the marker on a
          // finalize error: that would guarantee a second post next hour.
          logger.warn(
            { householdId: record.householdId, kind, err: (err as Error).message },
            'household_channel.finalize_failed'
          );
        });
      await recordOutcome(record, attempt, now);
      posted = true;
      continue;
    }

    await store.releasePost(record.householdId, kind, periodKey, reservationId).catch((err) => {
      logger.warn(
        { householdId: record.householdId, kind, err: (err as Error).message },
        'household_channel.release_failed'
      );
    });
    await recordOutcome(record, attempt, now);
    // One failed post ends this channel's hour. No second post into a
    // webhook that just refused one.
    return 'failed_delivery';
  }
  return posted ? 'posted' : 'nothing_due';
}

export interface ChannelRunSummary {
  channels: number;
  attempted: number;
  posted: number;
  held: number;
  backingOff: number;
  disabled: number;
  failedDelivery: number;
  /** Visits that could not settle what was due. Kept apart from a quiet hour. */
  unknown: number;
  /** Visits that threw (a failed read). */
  failed: number;
  truncated: boolean;
}

/**
 * One pass over every configured channel. Best-effort per channel, like every
 * other pass on this schedule: one household's failure never stops another's.
 */
export async function runHouseholdChannels(
  now: Date = new Date(),
  options: { deadlineAt?: number } = {},
  deps?: DeliveryDeps
): Promise<ChannelRunSummary> {
  const channels = await store.listChannels();
  const byHousehold = new Map(channels.map((record) => [record.householdId, record]));
  const summary: ChannelRunSummary = {
    channels: channels.length,
    attempted: 0,
    posted: 0,
    held: 0,
    backingOff: 0,
    disabled: 0,
    failedDelivery: 0,
    unknown: 0,
    failed: 0,
    truncated: false,
  };

  const fanOut = await scheduledFanOut.fanOutHouseholds(
    'householdChannels',
    [...byHousehold.keys()],
    async (householdId) => {
      const record = byHousehold.get(householdId);
      if (!record) return;
      try {
        const visit = await visitChannel(record, now, deps);
        if (visit === 'posted') summary.posted += 1;
        else if (visit === 'held') summary.held += 1;
        else if (visit === 'backing_off') summary.backingOff += 1;
        else if (visit === 'disabled') summary.disabled += 1;
        else if (visit === 'failed_delivery') summary.failedDelivery += 1;
        else if (visit === 'unknown') summary.unknown += 1;
      } catch (err) {
        summary.failed += 1;
        logger.warn(
          { householdId, err: (err as Error).message, msg: 'household_channel.visit_failed' },
          'household_channel.visit_failed'
        );
      }
    },
    { deadlineAt: options.deadlineAt }
  );
  summary.attempted = fanOut.attempted;
  summary.truncated = fanOut.truncated;

  logger.info(
    { ...summary, msg: 'household_channel.run_complete' },
    'household_channel.run_complete'
  );
  return summary;
}
