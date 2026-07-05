/**
 * Reminder fan-out. Two entrypoints share one per-household routine:
 *   - `remindHousehold` — used by the admin "send reminders now" HTTP route
 *     (`handlers/notifications/handler.ts`).
 *   - `remindAllHouseholds` — used by the hourly EventBridge scan
 *     (`handlers/reminders/handler.ts`).
 *
 * For each member we roll their due/overdue tasks into a single notification so
 * a busy household doesn't get one ping per plant. Delivery goes through
 * `notifier.sendToUser`, which respects per-user channel prefs + the DND window
 * and degrades to a structured log line when a channel isn't configured.
 *
 * Spam control: the scan is hourly and the due window is 24h, so the same due
 * task is eligible on every run. A per-user, per-day dedupe marker (conditional
 * Put on USER#{id} / REMINDED#{yyyy-mm-dd}) caps delivery at one reminder per
 * user per UTC day — email/SMS are billed per send, so this matters. The marker
 * is claimed AFTER a channel actually delivers (see claimDailyReminderSlot):
 * claiming it up front silently dropped the day's reminder for DND users who
 * rely on email/SMS, since DND suppresses those channels (H1).
 *
 * Query shape: ONE GSI1 due-window query per household (the same pattern as
 * getUpcomingTasks), grouped by assignee in memory. The old shape was one GSI2
 * query per member, which both multiplied reads and silently dropped
 * unassigned tasks (they're in nobody's GSI2 partition).
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { Task } from '../models/types.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as plantService from './plantService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as pestAlerts from './pestAlerts.js';
import * as notifier from './notifier.js';

const DUE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Markers outlive their day by a comfortable margin; DynamoDB TTL sweeps them.
const MARKER_TTL_SECONDS = 48 * 60 * 60;

function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10); // yyyy-mm-dd (UTC)
}

/**
 * Has this user already been reminded today FOR THIS HOUSEHOLD? A point read
 * on the per-user, per-household, per-day marker, used to skip a member up
 * front on subsequent hourly runs (before building/sending the roll-up). The
 * authoritative dedupe is still the conditional Put in
 * `claimDailyReminderSlot`; this is the cheap pre-check.
 *
 * The marker is scoped to the household, not just the user: a member of two
 * households must be reminded about each independently. A user-only key
 * (no household component) let the FIRST household processed in a run claim
 * the user's entire day, silently skipping every other household's
 * reminder — the multi-household reminders/digest is a real, marketed
 * scenario (see docs/multi-household.md), not an edge case.
 */
async function alreadyRemindedToday(
  userId: string,
  householdId: string,
  now: Date
): Promise<boolean> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: `REMINDED#${householdId}#${dateKey(now)}` },
    })
  );
  return Boolean(result.Item);
}

/**
 * Conditionally claim the user's "reminded today" slot FOR THIS HOUSEHOLD.
 * Returns true when the marker was absent (we own today's send), false when
 * a previous run already claimed it. See `alreadyRemindedToday` for why the
 * key includes householdId.
 *
 * Written AFTER a channel actually delivered (H1): the slot must reflect a
 * real send, not merely an attempt. The old order claimed the slot BEFORE
 * sending, which silently burned the day for DND users who rely on email/SMS —
 * DND suppresses those channels (only browser push survives), so a push-less
 * DND user got the marker written but no reminder, and every later hourly run
 * skipped them. We now claim only once `notifier.sendToUser` reports a
 * delivery, so a DND-suppressed user is retried on the next run instead.
 */
async function claimDailyReminderSlot(
  userId: string,
  householdId: string,
  now: Date
): Promise<boolean> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${userId}`,
          SK: `REMINDED#${householdId}#${dateKey(now)}`,
          entityType: 'ReminderMarker',
          sentAt: now.toISOString(),
          ttl: Math.floor(now.getTime() / 1000) + MARKER_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

/**
 * Notify each member of one household about tasks due within the next 24h
 * (or already overdue): the member's own assigned tasks plus the household's
 * unassigned ones (otherwise unassigned tasks would notify nobody). Returns
 * how many members were sent a reminder.
 */
export async function remindHousehold(
  householdId: string,
  now: Date = new Date()
): Promise<number> {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() + DUE_WINDOW_MS).toISOString();

  // One due-window query for the whole household. When nothing is due we
  // skip the member + plant reads entirely — the common case most hours.
  const dueWindowTasks = await taskService.getTasksDueBy(householdId, cutoff);

  let due: Task[] = [];
  if (dueWindowTasks.length > 0) {
    // Don't remind about plants that are no longer active (died / gave away).
    // getPlants defaults to active-only, so any task whose plant isn't in this
    // set belongs to a past plant and is skipped.
    const activePlantIds = new Set((await plantService.getPlants(householdId)).map((p) => p.id));
    due = dueWindowTasks.filter((t) => activePlantIds.has(t.plantId));
  }

  let sent = 0;
  if (due.length > 0) {
    const members = await householdService.getHouseholdMembers(householdId);
    const memberIds = new Set(members.map((m) => m.userId));

    // Vacation mode (read-time mapping): tasks assigned to a member with a
    // currently-active window are delivered to their cover instead. Windows
    // auto-expire — getActiveVacationMap filters by start/end, so the day
    // after endDate everything routes back to the original assignee with no
    // data rewrite.
    const vacations = await taskService.getActiveVacationMap(householdId, now);

    /** Who a task's reminder should go to right now (null = unassigned). */
    const effectiveAssignee = (t: Task): string | null => {
      if (!t.assignedTo) return null;
      const w = vacations.get(t.assignedTo);
      if (w && w.coveredBy !== t.assignedTo && memberIds.has(w.coveredBy)) return w.coveredBy;
      return t.assignedTo;
    };

    /** Can this user actually receive the reminder? Members who are away
     *  are skipped below, so a task routed to them must roll up instead
     *  (covers "the designated cover has since left the household"). */
    const deliverable = (userId: string | null): boolean =>
      userId !== null && memberIds.has(userId) && !vacations.has(userId);

    // Unassigned tasks — and tasks whose effective assignee can't be
    // reached (left the household, or away with no valid cover) — roll up
    // into every member's reminder so they don't silently fall on the floor.
    const unassigned = due.filter((t) => !deliverable(effectiveAssignee(t)));

    for (const member of members) {
      // A member who is away gets no reminders at all — that's the point of
      // vacation mode. Their tasks are in someone else's `mine` below.
      if (vacations.has(member.userId)) continue;

      const mine = due.filter((t) => effectiveAssignee(t) === member.userId);
      const tasksForMember = [...mine, ...unassigned];
      if (tasksForMember.length === 0) continue;

      // Per-user daily dedupe — see claimDailyReminderSlot. Cheap pre-check
      // up front so an already-reminded member skips the roll-up build + send
      // entirely on later hourly runs. The slot is only CLAIMED below, after a
      // channel actually delivered (H1).
      if (await alreadyRemindedToday(member.userId, householdId, now)) continue;

      const overdue = tasksForMember.filter((t) => t.nextDue < nowIso).length;
      let body = overdue
        ? `${overdue} ready for some catch-up care, ${tasksForMember.length - overdue} coming up soon`
        : `${tasksForMember.length} task${tasksForMember.length === 1 ? '' : 's'} coming up in the next 24h`;

      // Tell the cover whose tasks they're picking up.
      const coveringNames = [
        ...new Set(
          mine
            .filter((t) => t.assignedTo && t.assignedTo !== member.userId)
            .map(
              (t) =>
                members.find((m) => m.userId === t.assignedTo)?.name ??
                t.assignedToName ??
                'a housemate'
            )
        ),
      ];
      if (coveringNames.length > 0) {
        body += ` (covering for ${coveringNames.join(', ')})`;
      }

      const result = await notifier.sendToUser(
        { userId: member.userId, email: member.email },
        { title: 'Plant care reminder', body, tag: 'reminder' }
      );

      if (result.delivered) {
        // Burn the day only on a real delivery, so a transient race can't
        // double-claim either. The conditional Put is still authoritative.
        if (await claimDailyReminderSlot(member.userId, householdId, now)) {
          sent += 1;
        }
      } else if (result.dndSuppressedOnly) {
        // Reachable only via DND-suppressed email/SMS: don't claim the slot —
        // the next hourly run retries once the DND window lifts (H1).
        logger.info(
          { householdId, userId: member.userId },
          'reminders.dnd_suppressed_retry_next_run'
        );
      }
    }
  }

  // Seasonal pest alerts ride along with the reminder run (the prefs toggle
  // previously had no caller at all). Best-effort: a pest evaluation failure
  // must never fail task reminders.
  try {
    await runPestAlerts(householdId, now);
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'reminders.pest_alerts_failed');
  }

  return sent;
}

/**
 * Evaluate + deliver seasonal pest alerts for one household, for members who
 * opted in via notification prefs (`pestAlerts: true`).
 *
 * Gated by a per-household, per-day marker: the reminder scan is hourly, but
 * pest evaluation reads every member's prefs and (on cache miss) the Perenual
 * API — once a day is plenty for a "this season" heads-up.
 *
 * The 90-day per-plant/pest suppression marker is written only AFTER at least
 * one successful delivery, so a failed send doesn't mute the alert for a
 * quarter.
 */
async function runPestAlerts(householdId: string, now: Date): Promise<void> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `PEST_CHECK#${dateKey(now)}`,
          entityType: 'PestCheckMarker',
          checkedAt: now.toISOString(),
          ttl: Math.floor(now.getTime() / 1000) + MARKER_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return; // already evaluated today
    }
    throw err;
  }

  const members = await householdService.getHouseholdMembers(householdId);
  const optedIn = [];
  for (const member of members) {
    const prefs = await notificationPrefs.getPreferences(member.userId);
    if (prefs.pestAlerts) optedIn.push(member);
  }
  if (optedIn.length === 0) return;

  const alerts = await pestAlerts.evaluatePestAlerts(householdId, now);
  for (const alert of alerts) {
    let delivered = false;
    for (const member of optedIn) {
      try {
        await notifier.sendToUser(
          { userId: member.userId, email: member.email },
          { title: 'Pest season heads-up', body: alert.message, tag: 'pest-alert' }
        );
        delivered = true;
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, householdId, userId: member.userId },
          'reminders.pest_alert_send_failed'
        );
      }
    }
    if (delivered) {
      await pestAlerts.markAlerted(alert.plantId, alert.pestId);
    }
  }
}

/**
 * Hourly scan across every household. Best-effort per household — one
 * household's failure must not abort the rest of the run.
 */
export async function remindAllHouseholds(
  now: Date = new Date()
): Promise<{ households: number; sent: number }> {
  const ids = await householdService.listAllHouseholdIds();
  let sent = 0;
  for (const id of ids) {
    try {
      sent += await remindHousehold(id, now);
    } catch (err) {
      // Best-effort, but never silent: a swallowed error here previously hid
      // real failures (e.g. Intl throwing on a corrupt stored timezone, which
      // aborted reminders for every member after the bad one).
      logger.warn({ err: (err as Error).message, householdId: id }, 'reminders.household_failed');
    }
  }
  return { households: ids.length, sent };
}
