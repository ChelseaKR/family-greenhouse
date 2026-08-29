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
 * task is eligible on every run. A per-user, per-household, per-day dedupe
 * marker per delivery channel caps each channel at one reminder for each
 * household per recipient-local calendar day. Each channel is atomically
 * reserved BEFORE delivery, finalized only when that provider accepts the
 * notification, and released after a failed/deferred attempt. That ordering
 * prevents overlapping scheduler/manual runs from duplicating a successful
 * channel without letting email success suppress an SMS retry (or browser
 * push during DND suppress email/SMS once quiet hours end).
 *
 * Query shape: ONE GSI1 due-window query per household (the same pattern as
 * getUpcomingTasks), grouped by assignee in memory. The old shape was one GSI2
 * query per member, which both multiplied reads and silently dropped
 * unassigned tasks (they're in nobody's GSI2 partition).
 */
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { localDateKey } from '../utils/localDate.js';
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
// Long enough for the notifier's provider calls, short enough that a killed
// Lambda is retried during the next hourly scan rather than suppressing a day.
const DELIVERY_LEASE_SECONDS = 5 * 60;

// Single implementation, shared with the digest's calendar-day math so the
// two surfaces cannot drift apart on what "day" means (see
// utils/localDate.ts). Re-exported because callers and tests import it from
// here. Behaviour is unchanged, with one addition: an unrecognized zone now
// degrades to UTC instead of throwing inside a scheduled scan.
export { localDateKey };

function aggregateReminderMarkerKeys(
  userId: string,
  householdId: string,
  now: Date,
  timeZone: string
): Array<{ PK: string; SK: string }> {
  const localDate = localDateKey(now, timeZone);
  return [
    // Original production shape used the UTC date and one reminder for the
    // user across every household. Keep it authoritative while it ages out.
    { PK: `USER#${userId}`, SK: `REMINDED#${now.toISOString().slice(0, 10)}` },
    // Intermediate shape: household-scoped, but still aggregate by channel.
    {
      PK: `USER#${userId}`,
      SK: `REMINDED#${localDate}#HOUSEHOLD#${householdId}`,
    },
  ];
}

function markerStillBlocksDelivery(
  item: Record<string, unknown> | undefined,
  nowEpoch: number
): boolean {
  if (!item) return false;
  const ttl = Number(item.ttl ?? 0);
  if (ttl > 0 && ttl <= nowEpoch) return false;
  if (item.status !== 'sending') return true;
  return Number(item.leaseExpiresAt ?? 0) > nowEpoch;
}

/**
 * Deploy compatibility: aggregate markers written by either previous schema
 * mean that day's reminder already went out on at least one channel. Treat
 * them as all-channel completion until their TTL/lease expires, avoiding a
 * deploy-day resend when channel-scoped markers first ship.
 */
async function hasAggregateReminderMarker(
  userId: string,
  householdId: string,
  now: Date,
  timeZone: string
): Promise<boolean> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const results = await Promise.all(
    aggregateReminderMarkerKeys(userId, householdId, now, timeZone).map((Key) =>
      dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key }))
    )
  );
  return results.some((result) =>
    markerStillBlocksDelivery(result.Item as Record<string, unknown> | undefined, nowEpoch)
  );
}

function reminderChannelMarkerKey(
  userId: string,
  householdId: string,
  now: Date,
  timeZone: string,
  channel: notifier.NotificationChannel
): { PK: string; SK: string } {
  return {
    PK: `USER#${userId}`,
    SK: `REMINDED#${localDateKey(now, timeZone)}#HOUSEHOLD#${householdId}#CHANNEL#${channel}`,
  };
}

/**
 * Conditionally reserve one channel's "reminded today" slot. A completed or
 * live reservation returns null; an expired reservation is reclaimable.
 */
async function reserveDailyReminderChannel(
  userId: string,
  householdId: string,
  now: Date,
  timeZone: string,
  channel: notifier.NotificationChannel
): Promise<string | null> {
  const reservationId = randomUUID();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...reminderChannelMarkerKey(userId, householdId, now, timeZone, channel),
          entityType: 'ReminderMarker',
          channel,
          status: 'sending',
          reservationId,
          leaseExpiresAt: nowEpoch + DELIVERY_LEASE_SECONDS,
          ttl: nowEpoch + MARKER_TTL_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(PK) OR (#status = :sending AND leaseExpiresAt <= :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':sending': 'sending', ':now': nowEpoch },
      })
    );
    return reservationId;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return null;
    }
    throw err;
  }
}

async function releaseDailyReminderChannel(
  userId: string,
  householdId: string,
  now: Date,
  timeZone: string,
  channel: notifier.NotificationChannel,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: reminderChannelMarkerKey(userId, householdId, now, timeZone, channel),
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}

async function finalizeDailyReminderChannel(
  userId: string,
  householdId: string,
  now: Date,
  timeZone: string,
  channel: notifier.NotificationChannel,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: reminderChannelMarkerKey(userId, householdId, now, timeZone, channel),
      UpdateExpression:
        'SET #status = :sent, sentAt = :sentAt REMOVE leaseExpiresAt, reservationId',
      ConditionExpression: '#status = :sending AND reservationId = :reservationId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sent': 'sent',
        ':sending': 'sending',
        ':sentAt': now.toISOString(),
        ':reservationId': reservationId,
      },
    })
  );
}

function eligibleReminderChannels(
  prefs: notificationPrefs.NotificationPreferences,
  now: Date
): {
  eligible: notifier.NotificationChannel[];
  dndDeferred: notifier.NotificationChannel[];
} {
  const eligible: notifier.NotificationChannel[] = [];
  const dndDeferred: notifier.NotificationChannel[] = [];
  const inDnd = notificationPrefs.isInDndWindow(prefs, now);

  if (prefs.browser) eligible.push('browser');
  if (prefs.email) {
    (inDnd ? dndDeferred : eligible).push('email');
  }
  if (prefs.sms && prefs.phone && prefs.phoneVerified) {
    (inDnd ? dndDeferred : eligible).push('sms');
  }
  return { eligible, dndDeferred };
}

function frontendUrl(path: string): string {
  const base = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';
  return new URL(path, base).toString();
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

      // Keep aggregate markers written by earlier releases authoritative until
      // they age out, then reserve only the still-pending eligible channels.
      const memberPrefs = await notificationPrefs.getPreferences(member.userId);
      const timeZone = memberPrefs.timezone || 'UTC';
      if (await hasAggregateReminderMarker(member.userId, householdId, now, timeZone)) {
        continue;
      }
      const channelPlan = eligibleReminderChannels(memberPrefs, now);
      if (memberPrefs.sms && memberPrefs.phone && !memberPrefs.phoneVerified) {
        logger.info(
          { userId: member.userId, msg: 'sms_skipped_unverified' },
          'sms_skipped_unverified'
        );
      }
      if (channelPlan.dndDeferred.length > 0) {
        logger.info(
          {
            householdId,
            userId: member.userId,
            channels: channelPlan.dndDeferred,
          },
          'reminders.dnd_deferred_retry_next_run'
        );
      }

      const reservations = new Map<notifier.NotificationChannel, string>();
      for (const channel of channelPlan.eligible) {
        const reservationId = await reserveDailyReminderChannel(
          member.userId,
          householdId,
          now,
          timeZone,
          channel
        );
        if (reservationId) reservations.set(channel, reservationId);
      }
      if (reservations.size === 0) continue;

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

      let result: notifier.SendResult;
      try {
        result = await notifier.sendToUser(
          { userId: member.userId, email: member.email },
          {
            title: 'Plant care reminder',
            body,
            tag: `reminder-${householdId}-${localDateKey(now, timeZone)}`,
            url: frontendUrl('/tasks?filter=due'),
          },
          {
            channels: [...reservations.keys()],
            now,
            preferences: memberPrefs,
          }
        );
      } catch (err) {
        await Promise.all(
          [...reservations].map(([channel, reservationId]) =>
            releaseDailyReminderChannel(
              member.userId,
              householdId,
              now,
              timeZone,
              channel,
              reservationId
            ).catch((cleanupErr) => {
              logger.warn(
                {
                  err: (cleanupErr as Error).message,
                  channel,
                  householdId,
                  userId: member.userId,
                },
                'reminders.reservation_cleanup_failed'
              );
            })
          )
        );
        logger.warn(
          { err: (err as Error).message, householdId, userId: member.userId },
          'reminders.send_failed'
        );
        continue;
      }

      let memberDelivered = false;
      await Promise.all(
        [...reservations].map(async ([channel, reservationId]) => {
          if (result.channels[channel] === 'delivered') {
            memberDelivered = true;
            await finalizeDailyReminderChannel(
              member.userId,
              householdId,
              now,
              timeZone,
              channel,
              reservationId
            ).catch((err) => {
              // A provider accepted this channel. Never delete its marker on a
              // finalize error: doing so would guarantee a duplicate next run.
              logger.warn(
                {
                  err: (err as Error).message,
                  channel,
                  householdId,
                  userId: member.userId,
                },
                'reminders.reservation_finalize_failed'
              );
            });
            return;
          }
          await releaseDailyReminderChannel(
            member.userId,
            householdId,
            now,
            timeZone,
            channel,
            reservationId
          ).catch((err) => {
            logger.warn(
              {
                err: (err as Error).message,
                channel,
                householdId,
                userId: member.userId,
              },
              'reminders.reservation_cleanup_failed'
            );
          });
        })
      );
      if (memberDelivered) sent += 1;
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
 *
 * The per-day marker itself is written BEFORE evaluation (needed as a
 * test-and-set guard so two hourly runs for the same household don't
 * double-process), but it's deleted again afterward whenever evaluation
 * DIDN'T fully complete — either because it reported Perenual was
 * unreachable for any plant this hour, or because something in the
 * evaluation path threw outright (a member/prefs read failing,
 * evaluatePestAlerts itself throwing, etc.). Otherwise a transient outage,
 * an exhausted daily budget, OR an unhandled crash would all look exactly
 * like "checked, nothing to report" and silently lose the whole day's pest
 * alerts with no way to retry until tomorrow.
 */
async function runPestAlerts(householdId: string, now: Date): Promise<void> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `PEST_CHECK#${now.toISOString().slice(0, 10)}`,
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

  let dataUnavailable = false;
  // A channel/provider failure is retryable just like unavailable pest data.
  // Without clearing the daily marker, a resolved `{ delivered: false }`
  // result (dry-run, DND, or all providers failing) used to suppress the pest
  // alert for the rest of the day and, worse, was treated as a successful
  // delivery for the 90-day per-pest marker below.
  let deliveryPending = false;
  // Only flips to true once the try block runs to completion (including the
  // "nobody opted in" early return). Any thrown exception along the way — a
  // member/prefs read failing, evaluatePestAlerts itself throwing, a
  // markAlerted failure — leaves this false, so the finally below cleans up
  // the marker exactly as it would for an explicit dataUnavailable result,
  // instead of leaving a household wrongly marked "checked" after a crash.
  let completed = false;
  try {
    const members = await householdService.getHouseholdMembers(householdId);
    const optedIn = [];
    for (const member of members) {
      const prefs = await notificationPrefs.getPreferences(member.userId);
      if (prefs.pestAlerts) optedIn.push(member);
    }
    if (optedIn.length === 0) {
      completed = true;
      return;
    }

    const result = await pestAlerts.evaluatePestAlerts(householdId, now);
    dataUnavailable = result.dataUnavailable;
    for (const alert of result.alerts) {
      for (const member of optedIn) {
        if (await pestAlerts.wasAlerted(member.userId, alert.plantId, alert.pestId, now)) {
          continue;
        }
        try {
          const sendResult = await notifier.sendToUser(
            { userId: member.userId, email: member.email },
            {
              title: 'Pest season heads-up',
              body: alert.message,
              tag: `pest-alert-${householdId}-${alert.plantId}-${alert.pestId}`,
              url: frontendUrl(`/plants/${encodeURIComponent(alert.plantId)}`),
            }
          );
          if (sendResult.delivered) {
            await pestAlerts.markAlerted(member.userId, alert.plantId, alert.pestId, now);
          } else {
            deliveryPending = true;
          }
        } catch (err) {
          deliveryPending = true;
          logger.warn(
            { err: (err as Error).message, householdId, userId: member.userId },
            'reminders.pest_alert_send_failed'
          );
        }
      }
    }
    completed = true;
  } finally {
    if (dataUnavailable || deliveryPending || !completed) {
      await dynamodb
        .send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: `HOUSEHOLD#${householdId}`,
              SK: `PEST_CHECK#${now.toISOString().slice(0, 10)}`,
            },
          })
        )
        .catch((err) => {
          logger.warn(
            { err: (err as Error).message, householdId },
            'reminders.pest_check_marker_cleanup_failed'
          );
        });
    }
  }
}

/**
 * Hourly scan across every household. Best-effort per household — one
 * household's failure must not abort the rest of the run.
 *
 * `households` is how many were ATTEMPTED and `failed` how many of those
 * threw. Without `failed`, a run where every household crashed summarised
 * as `{ households: N, sent: 0 }` — indistinguishable from "nobody had
 * anything due".
 */
export async function remindAllHouseholds(
  now: Date = new Date()
): Promise<{ households: number; sent: number; failed: number }> {
  const ids = await householdService.listAllHouseholdIds();
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      sent += await remindHousehold(id, now);
    } catch (err) {
      // Best-effort, but never silent: a swallowed error here previously hid
      // real failures (e.g. Intl throwing on a corrupt stored timezone, which
      // aborted reminders for every member after the bad one).
      failed += 1;
      logger.warn({ err: (err as Error).message, householdId: id }, 'reminders.household_failed');
    }
  }
  return { households: ids.length, sent, failed };
}
