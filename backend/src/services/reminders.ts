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
 * "Accepted" is the honest word for the email leg: SES taking custody is not
 * receipt, and the bounce arrives minutes later (see `emailNotifier`). The
 * marker is therefore protected from the other side — an address the feedback
 * loop has already condemned is dropped from the channel plan before a lease
 * is reserved, so no day can ever be marked sent against a dead mailbox.
 *
 * Query shape: ONE GSI1 due-window query per household (the same pattern as
 * getUpcomingTasks), grouped by assignee in memory. The old shape was one GSI2
 * query per member, which both multiplied reads and silently dropped
 * unassigned tasks (they're in nobody's GSI2 partition).
 *
 * Content: `services/reminderEmail.ts` turns the rows this file already read
 * into words. The reminder used to be two integers and a link to a filtered
 * list while `Task[]` sat in scope on the line above the payload; it now names
 * every plant and task, deep-links each to its own plant page, marks unclaimed
 * tasks as claimable rather than folding them into an anonymous count, and
 * says why a cover is covering.
 *
 * What "sent" means here: a finalized marker records that a PROVIDER ACCEPTED
 * the notification, not that a person received it. `emailNotifier.sendEmail`
 * returns true the moment SES resolves `SendEmailCommand`, and there is no SES
 * configuration set, bounce destination or suppression list anywhere in
 * `infrastructure/`, so a hard bounce still finalizes the day's marker as
 * `sent`. That gap is real and is owned by the deliverability work, not by
 * this file — nothing here may widen it. In particular, no code path may start
 * treating `status: 'sent'` as evidence of receipt.
 */
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { Task } from '../models/types.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as plantService from './plantService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as pestAlerts from './pestAlerts.js';
import * as notifier from './notifier.js';
import * as climate from './climate.js';
import * as reminderEmail from './reminderEmail.js';
import type { ReminderClimate, ReminderTaskRow, DueState } from './reminderEmail.js';
import * as emailSuppression from './emailSuppression.js';

const DUE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The locale every reminder is composed in today.
 *
 * `reminderEmail` carries complete en + es catalogs, but nothing in the
 * backend stores a user's language: `NotificationPreferences` has `timezone`
 * and no locale, and Cognito's custom schema adds only household id/role. When
 * the per-user locale field lands (branch `feat/useful-emails` owns it), this
 * constant becomes a read of that field and nothing else here changes.
 */
const REMINDER_LOCALE_ADOPTION: reminderEmail.ReminderLocale = 'en';
// Markers outlive their day by a comfortable margin; DynamoDB TTL sweeps them.
const MARKER_TTL_SECONDS = 48 * 60 * 60;
// Long enough for the notifier's provider calls, short enough that a killed
// Lambda is retried during the next hourly scan rather than suppressing a day.
const DELIVERY_LEASE_SECONDS = 5 * 60;

export function localDateKey(now: Date, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

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

/**
 * Close out one channel's daily slot. `status: 'sent'` records that a PROVIDER
 * ACCEPTED the notification — for email that is SES taking custody, not
 * receipt, and the bounce (if there is one) arrives minutes later on a
 * different path entirely (`handlers/emailEvents`). Nothing synchronous can
 * say more than that, so the marker does not pretend to.
 *
 * What keeps that from being a lie in practice is the other end: an address
 * the feedback loop has condemned never reaches a reservation at all (see
 * `eligibleReminderChannels`), so this can never stamp a day 'sent' against a
 * mailbox already known to be dead.
 */
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

/**
 * Which channels this member can be reached on right now.
 *
 * Preferences answer most of it. The one thing they cannot answer is whether
 * the recipient's mailbox still accepts mail — a member's email is written
 * once at join time and never re-examined — so the suppression list is
 * consulted here, BEFORE any daily lease is reserved. That ordering is the
 * point: a permanently dead mailbox drops out of the plan instead of
 * reserving and releasing a marker every hour, forever, and no day can be
 * finalized against an address the feedback loop has already condemned.
 *
 * It is a belt to the notifier's braces. A send that still reaches
 * `emailNotifier` for a suppressed address is refused there too and comes back
 * as `undeliverable`, which never finalizes.
 *
 * An `unknown` suppression lookup deliberately LEAVES email in the plan: the
 * send path re-checks and declines if it still cannot tell, and that path
 * releases the lease so the next hourly run retries. Dropping the channel on a
 * failed read would silence a working mailbox over a DynamoDB blip — the same
 * defect pointed the other way (ADR 0010).
 */
async function eligibleReminderChannels(
  prefs: notificationPrefs.NotificationPreferences,
  now: Date,
  recipient: { email: string; householdId: string }
): Promise<{
  eligible: notifier.NotificationChannel[];
  dndDeferred: notifier.NotificationChannel[];
}> {
  const eligible: notifier.NotificationChannel[] = [];
  const dndDeferred: notifier.NotificationChannel[] = [];
  const inDnd = notificationPrefs.isInDndWindow(prefs, now);

  if (prefs.browser) eligible.push('browser');
  if (prefs.email && (await emailIsReachable(recipient, now))) {
    (inDnd ? dndDeferred : eligible).push('email');
  }
  if (prefs.sms && prefs.phone && prefs.phoneVerified) {
    (inDnd ? dndDeferred : eligible).push('sms');
  }
  return { eligible, dndDeferred };
}

/** True unless the address is on the suppression list. See the note above for
 *  why an unreadable list answers true rather than false. */
async function emailIsReachable(
  recipient: { email: string; householdId: string },
  now: Date
): Promise<boolean> {
  const status = await emailSuppression.checkAddress(recipient.email);
  if (status.status !== 'suppressed') return true;
  logger.warn(
    {
      householdId: recipient.householdId,
      reason: status.state.reason,
      suppressedAt: status.state.suppressedAt,
      now: now.toISOString(),
    },
    'reminders.email_address_suppressed'
  );
  return false;
}

function frontendUrl(path: string): string {
  const base = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';
  return new URL(path, base).toString();
}

/**
 * Where one task sits relative to `now`.
 *
 * `unknown` is returned for a `nextDue` that does not parse. The digest's
 * equivalent arithmetic renders `waiting NaN days for some care`; a named
 * state means the reminder can say "we could not read this date" instead of
 * printing a number it does not have.
 */
function dueStateFor(nextDue: string | null | undefined, now: Date): DueState {
  const parsed = nextDue ? Date.parse(nextDue) : NaN;
  if (!Number.isFinite(parsed)) return { kind: 'unknown' };
  const diffMs = now.getTime() - parsed;
  if (diffMs < 0) return { kind: 'upcoming' };
  const days = Math.floor(diffMs / DAY_MS);
  return days <= 0 ? { kind: 'today' } : { kind: 'overdue', days };
}

/** Most urgent first: longest-overdue, then today, then upcoming, then the
 *  rows whose due date we could not read (last, but never dropped). */
const DUE_RANK: Record<DueState['kind'], number> = {
  overdue: 0,
  today: 1,
  upcoming: 2,
  unknown: 3,
};

function compareRows(a: ReminderTaskRow, b: ReminderTaskRow): number {
  const rank = DUE_RANK[a.due.kind] - DUE_RANK[b.due.kind];
  if (rank !== 0) return rank;
  if (a.due.kind === 'overdue' && b.due.kind === 'overdue') return b.due.days - a.due.days;
  return (a.plantName ?? '').localeCompare(b.plantName ?? '');
}

/**
 * Today's forecast for one household, reduced to the two signals a care
 * reminder can act on.
 *
 * Deliberately derived here rather than reusing `climate.deriveClimateTips`:
 * that function returns English prose with no stable identifier, and this
 * email ships in two languages. The thresholds are the same ones, and
 * `reminders.climate.test.ts` asserts the two agree on the same snapshot so
 * they cannot drift apart silently.
 *
 * Every failure path returns `{ status: 'unavailable' }` — a NAMED state, not
 * an empty one. A reminder that could not read the weather says nothing about
 * the weather; it must never imply "no rain expected".
 */
async function readReminderClimate(householdId: string): Promise<ReminderClimate> {
  try {
    const household = await householdService.getHousehold(householdId);
    if (!household?.location) return { status: 'unavailable' };
    const snapshot = await climate.getWeatherCached(household.location.lat, household.location.lon);
    if (!snapshot) return { status: 'unavailable' };
    const condition = snapshot.condition.toLowerCase();
    const todayLow = snapshot.forecast[0]?.minC ?? snapshot.tempC;
    return {
      status: 'read',
      rain: condition.includes('rain') || condition.includes('storm'),
      frostLowC: todayLow < 5 ? todayLow : null,
    };
  } catch (err) {
    // Includes ClimateUnavailableError('not_configured'), which is the state
    // every reminder run is in until the Terraform change in this PR grants
    // the reminders Lambda `weather_environment`.
    logger.info(
      { householdId, err: (err as Error).message },
      'reminders.climate_unavailable_no_tip'
    );
    return { status: 'unavailable' };
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
  const cutoff = new Date(now.getTime() + DUE_WINDOW_MS).toISOString();

  // One due-window query for the whole household. When nothing is due we
  // skip the member + plant reads entirely — the common case most hours.
  const dueWindowTasks = await taskService.getTasksDueBy(householdId, cutoff);

  let due: Task[] = [];
  // Authoritative plant names for the rows we are about to list. Every task in
  // `due` is filtered against this map's keys, so a lookup below can never
  // miss for a reason other than an empty stored name.
  const activePlantNames = new Map<string, string>();
  if (dueWindowTasks.length > 0) {
    // Don't remind about plants that are no longer active (died / gave away).
    // getPlants defaults to active-only, so any task whose plant isn't in this
    // set belongs to a past plant and is skipped.
    for (const plant of await plantService.getPlants(householdId)) {
      activePlantNames.set(plant.id, plant.name);
    }
    due = dueWindowTasks.filter((t) => activePlantNames.has(t.plantId));
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

    /** One rendered row. Plant names come from the active-plant read, which
     *  every task in `due` already matched; an empty stored name resolves to
     *  null so the composer says the name is missing rather than printing "". */
    const rowFor = (t: Task, upForGrabs: boolean): ReminderTaskRow => ({
      plantName: activePlantNames.get(t.plantId)?.trim() || null,
      taskLabel: reminderEmail.taskLabelFor(t.type, t.customType, REMINDER_LOCALE_ADOPTION),
      due: dueStateFor(t.nextDue, now),
      upForGrabs,
      url: frontendUrl(`/plants/${encodeURIComponent(t.plantId)}`),
    });

    // The forecast is read at most once per household per run, and only when a
    // member is actually about to be composed a reminder — the daily dedupe
    // marker means that is at most once a day in practice, not once an hour.
    let climateOnce: Promise<ReminderClimate> | null = null;
    const householdClimate = (): Promise<ReminderClimate> => {
      climateOnce ??= readReminderClimate(householdId);
      return climateOnce;
    };

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
      const channelPlan = await eligibleReminderChannels(memberPrefs, now, {
        email: member.email,
        householdId,
      });
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

      // Every row the member is on the hook for, named. `mine` are theirs;
      // `unassigned` are nobody's, and are marked claimable rather than folded
      // into an anonymous integer that five people each read as someone
      // else's problem.
      const rows = [
        ...mine.map((t) => rowFor(t, false)),
        ...unassigned.map((t) => rowFor(t, true)),
      ].sort(compareRows);

      // Tell the cover whose tasks they're picking up, and why. A member row
      // that failed to load yields `name: null` — the composer renders that as
      // an explicit failed lookup. It must never become a person called
      // "a housemate", which is what the previous `?? 'a housemate'` did.
      const coveredUserIds = [
        ...new Set(
          mine
            .filter((t) => t.assignedTo && t.assignedTo !== member.userId)
            .map((t) => t.assignedTo as string)
        ),
      ];
      const covering = coveredUserIds.map((userId) => ({
        name: reminderEmail.resolveCoveredName(
          members,
          userId,
          mine.find((t) => t.assignedTo === userId)?.assignedToName ?? null
        ),
        awayUntil: vacations.get(userId)?.endDate ?? null,
      }));

      const composed = reminderEmail.composeReminderEmail({
        rows,
        covering,
        climate: await householdClimate(),
        locale: REMINDER_LOCALE_ADOPTION,
        timeZone,
      });

      let result: notifier.SendResult;
      try {
        result = await notifier.sendToUser(
          { userId: member.userId, email: member.email },
          {
            title: composed.subject,
            body: composed.body,
            shortBody: composed.shortBody,
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
              // A provider ACCEPTED this channel — which is not the same as a
              // person receiving it; see the file header. Never delete its
              // marker on a finalize error: doing so would guarantee a
              // duplicate next run.
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
