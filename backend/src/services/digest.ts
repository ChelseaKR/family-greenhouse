/**
 * Weekly "plants at risk" digest + end-of-year recap emails.
 *
 * Entry points:
 *   - `runWeeklyDigests` / `runYearRecaps` — EventBridge-invoked scans across
 *     every household (`handlers/digests/handler.ts`), mirroring the
 *     reminders fan-out shape.
 *   - `digestHousehold` / `recapHousehold` — single-household routines shared
 *     with the admin manual triggers (`POST /notifications/run-digests` and
 *     `POST /notifications/run-year-recap` in handlers/notifications).
 *
 * Spam control mirrors services/reminders.ts: TTL'd conditional-Put dedupe
 * markers. The digest uses a per-user, per-household, per-ISO-week marker; the
 * recap uses a per-user, per-household, per-year marker held for ~60 days.
 * That scope skips successful retries without hiding a second household's
 * distinct summary.
 *
 * Both emails are plain text (see emailNotifier — no HTML email yet) and are
 * sent directly through `emailNotifier.sendEmail` rather than the
 * `notifier.sendToUser` fan-out: these are email-only products, and a weekly/
 * yearly summary shouldn't be silently rerouted to SMS or suppressed by a DND
 * window aimed at real-time pings.
 */
import { randomUUID } from 'node:crypto';
import { PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { calendarDaysBetween } from '../utils/localDate.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as plantService from './plantService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as emailNotifier from './emailNotifier.js';
import type { YearInReview } from './taskService.js';

/** Digest LISTS at most this many plants — it's a nudge, not an inventory.
 *  It does not cap what the digest may *count*: `composeDigestEmail` applies
 *  this to the body only, and the subject states the real total. */
const TOP_PLANTS = 5;
/** The recap LISTS this many "most pampered" plants. `review.topPlants` is
 *  complete; the cap is a display concern and lives here. */
const RECAP_TOP_PLANTS = 10;
// Weekly marker outlives its week by one day; DynamoDB TTL sweeps it.
const DIGEST_MARKER_TTL_SECONDS = 8 * 24 * 60 * 60;
// Per-user + household recap marker held ~60 days so January retries can't
// double-send members who already received that household's summary while
// still retrying failed recipients.
const RECAP_MARKER_TTL_SECONDS = 60 * 24 * 60 * 60;
const DELIVERY_LEASE_SECONDS = 5 * 60;

export interface PlantAtRisk {
  plantId: string;
  plantName: string;
  /** Task type of the plant's MOST overdue task (custom label when custom). */
  taskType: string;
  /** Whole days the most overdue task has been overdue (0 = overdue today). */
  daysOverdue: number;
}

function taskTypeLabel(t: { type: string; customType: string | null }): string {
  return t.type === 'custom' ? (t.customType ?? 'custom') : t.type;
}

/**
 * The household's plants most at risk: EVERY ACTIVE plant with at least one
 * overdue task, ranked by the max days-overdue across its tasks. One
 * due-window GSI1 query (cutoff = now ⇒ overdue only) plus the active-plant
 * read — the same shape the reminder scan uses.
 *
 * Deliberately uncapped. This used to `.slice(0, TOP_PLANTS)` before
 * returning, which made `atRisk.length` a number that could never exceed 5 —
 * and `composeDigestEmail` then built the subject from it, telling a
 * household with 23 neglected plants that "5 plants could use some care".
 * A cap is a display concern, so the cap now lives in the composer (which
 * still lists only the top few) and the count stays true.
 */
export async function computePlantsAtRisk(
  householdId: string,
  now: Date = new Date(),
  timeZone = 'UTC'
): Promise<PlantAtRisk[]> {
  const overdue = await taskService.getTasksDueBy(householdId, now.toISOString());
  if (overdue.length === 0) return [];

  // Don't flag plants that are no longer active (died / gave_away) —
  // getPlants defaults to active-only.
  const activePlants = new Map(
    (await plantService.getPlants(householdId)).map((p) => [p.id, p.name])
  );

  const byPlant = new Map<string, PlantAtRisk>();
  for (const task of overdue) {
    const plantName = activePlants.get(task.plantId);
    if (plantName === undefined) continue;
    // CALENDAR days, not elapsed 24h spans. `floor(elapsed / 24h)` disagreed
    // with the task list for every task whose due instant and the digest run
    // sit on different calendar days less than 24 hours apart — a task due
    // 23:00 and digested at 08:00 the next morning scored 0 and was phrased
    // "ready for a little care today" while the app said "1 day overdue".
    // Under-reporting is the dangerous direction here (#342 item 4).
    const daysOverdue = calendarDaysBetween(new Date(task.nextDue), now, timeZone);
    const current = byPlant.get(task.plantId);
    if (!current || daysOverdue > current.daysOverdue) {
      byPlant.set(task.plantId, {
        plantId: task.plantId,
        plantName,
        taskType: taskTypeLabel(task),
        daysOverdue,
      });
    }
  }

  return [...byPlant.values()].sort((a, b) => b.daysOverdue - a.daysOverdue);
}

function overduePhrase(days: number): string {
  if (days <= 0) return 'ready for a little care today';
  return days === 1 ? 'waiting a day for some care' : `waiting ${days} days for some care`;
}

/**
 * Plain-text weekly digest email body + subject.
 *
 * `atRisk` is the household's FULL ranked at-risk list. The subject reports
 * its real length; the body lists only the `TOP_PLANTS` waiting longest and
 * says so when it is showing a subset. Counting the listed rows instead —
 * what this did before — under-reported every household with more than five
 * neglected plants, and under-reporting is the dangerous direction for a
 * care-reminder product: it reassures precisely the households that most
 * need the nudge.
 */
export function composeDigestEmail(atRisk: PlantAtRisk[]): { subject: string; text: string } {
  const total = atRisk.length;
  const listed = atRisk.slice(0, TOP_PLANTS);
  const subject =
    total === 1
      ? 'Weekly digest: 1 plant could use some care'
      : `Weekly digest: ${total} plants could use some care`;
  const lines = listed.map(
    (p, i) => `${i + 1}. ${p.plantName} — ${p.taskType} ${overduePhrase(p.daysOverdue)}`
  );
  const plantWord = total === 1 ? 'plant' : 'plants';
  const intro =
    listed.length < total
      ? `${total} ${plantWord} could use some catch-up care. Here are the ${listed.length} waiting longest:`
      : `${total} ${plantWord} could use some catch-up care (the ${total === 1 ? 'one' : 'ones'} waiting longest first):`;
  const text = [
    'Your weekly Family Greenhouse check-in.',
    '',
    intro,
    '',
    ...lines,
    '',
    'A few minutes of care goes a long way. Your plants thank you!',
  ].join('\n');
  return { subject, text };
}

/** ISO-8601 week key (UTC), e.g. "2026-W24". Stable across the whole week, so
 *  retries and manual triggers inside the same week share one dedupe slot. */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // nearest Thursday decides the ISO year
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / (24 * 60 * 60 * 1000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Cheap pre-check (read) of this user's weekly digest marker — mirrors
 * reminders' `alreadyRemindedToday`. Lets an already-digested member be
 * skipped (no re-send) BEFORE we attempt a send, so a retry inside the same
 * ISO week never re-emails. The conditional claim below is still the
 * authoritative guard against a same-week race.
 */
async function alreadyDigestedThisWeek(
  userId: string,
  householdId: string,
  now: Date
): Promise<boolean> {
  const res = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}`,
        SK: `DIGEST#${isoWeekKey(now)}#HOUSEHOLD#${householdId}`,
      },
    })
  );
  if (!res.Item) return false;
  if (res.Item.status !== 'sending') return true;
  return Number(res.Item.leaseExpiresAt ?? 0) > Math.floor(now.getTime() / 1000);
}

/**
 * Conditionally reserve this user's digest slot for one household this ISO
 * week. The reservation happens before SES so overlapping scheduled/manual
 * runs cannot both send. Observed failures and dry-runs release it for retry.
 */
async function reserveWeeklyDigestSlot(
  userId: string,
  householdId: string,
  now: Date
): Promise<string | null> {
  const reservationId = randomUUID();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${userId}`,
          SK: `DIGEST#${isoWeekKey(now)}#HOUSEHOLD#${householdId}`,
          entityType: 'DigestMarker',
          status: 'sending',
          reservationId,
          leaseExpiresAt: nowEpoch + DELIVERY_LEASE_SECONDS,
          ttl: nowEpoch + DIGEST_MARKER_TTL_SECONDS,
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

async function releaseWeeklyDigestSlot(
  userId: string,
  householdId: string,
  now: Date,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}`,
        SK: `DIGEST#${isoWeekKey(now)}#HOUSEHOLD#${householdId}`,
      },
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}

async function finalizeWeeklyDigestSlot(
  userId: string,
  householdId: string,
  now: Date,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}`,
        SK: `DIGEST#${isoWeekKey(now)}#HOUSEHOLD#${householdId}`,
      },
      UpdateExpression:
        'SET #status = :sent, sentAt = :sentAt REMOVE leaseExpiresAt, reservationId',
      ConditionExpression: '#status = :sending AND reservationId = :reservationId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sent': 'sent',
        ':sending': 'sending',
        ':sentAt': new Date().toISOString(),
        ':reservationId': reservationId,
      },
    })
  );
}

/**
 * Send the weekly digest for ONE household. Households with nothing overdue
 * are skipped entirely (no member/prefs reads). Each member receives it only
 * when their email channel AND the weeklyDigest pref are on, at most once
 * per ISO week. Returns how many digests were sent.
 */
export async function digestHousehold(
  householdId: string,
  now: Date = new Date()
): Promise<number> {
  const atRisk = await computePlantsAtRisk(householdId, now);
  if (atRisk.length === 0) return 0;

  const { subject, text } = composeDigestEmail(atRisk);
  const members = await householdService.getHouseholdMembers(householdId);
  let sent = 0;
  for (const member of members) {
    const prefs = await notificationPrefs.getPreferences(member.userId);
    if (!prefs.email || !prefs.weeklyDigest) continue;
    // EventBridge retries at several UTC hours on Monday. Skip (without
    // claiming the weekly slot) during this recipient's local quiet window;
    // the next invocation can deliver once they are awake.
    if (notificationPrefs.isInDndWindow(prefs, now)) continue;
    // Cheap pre-check skips an already-digested member so a same-week retry
    // never re-emails.
    if (await alreadyDigestedThisWeek(member.userId, householdId, now)) continue;
    const reservationId = await reserveWeeklyDigestSlot(member.userId, householdId, now);
    if (!reservationId) continue;

    // Isolate each member's send. A false dry-run or provider exception
    // releases the reservation, so the next run retries that recipient.
    let delivered: boolean;
    try {
      delivered = await emailNotifier.sendEmail({ to: member.email, subject, text });
    } catch (err) {
      await releaseWeeklyDigestSlot(member.userId, householdId, now, reservationId).catch(
        (cleanupErr) => {
          logger.warn(
            { err: (cleanupErr as Error).message, householdId, userId: member.userId },
            'digest.reservation_cleanup_failed'
          );
        }
      );
      logger.warn(
        { err: (err as Error).message, householdId, userId: member.userId },
        'digest.send_failed'
      );
      continue;
    }
    if (delivered) {
      sent += 1;
      await finalizeWeeklyDigestSlot(member.userId, householdId, now, reservationId).catch(
        (err) => {
          logger.warn(
            { err: (err as Error).message, householdId, userId: member.userId },
            'digest.reservation_finalize_failed'
          );
        }
      );
    } else {
      await releaseWeeklyDigestSlot(member.userId, householdId, now, reservationId).catch((err) => {
        logger.warn(
          { err: (err as Error).message, householdId, userId: member.userId },
          'digest.reservation_cleanup_failed'
        );
      });
    }
  }
  return sent;
}

/**
 * Weekly EventBridge scan across every household. Best-effort per household —
 * one failure must not abort the rest of the run (same contract as
 * remindAllHouseholds).
 */
export async function runWeeklyDigests(
  now: Date = new Date()
): Promise<{ households: number; sent: number; failed: number }> {
  const ids = await householdService.listAllHouseholdIds();
  let sent = 0;
  // `households` counts attempts; `failed` keeps a run where every household
  // threw from summarising as "nobody had anything due".
  let failed = 0;
  for (const id of ids) {
    try {
      sent += await digestHousehold(id, now);
    } catch (err) {
      failed += 1;
      logger.warn({ err: (err as Error).message, householdId: id }, 'digest.household_failed');
    }
  }
  logger.info(
    { households: ids.length, sent, failed, msg: 'digest.run_complete' },
    'digest.run_complete'
  );
  return { households: ids.length, sent, failed };
}

// ---------------------------------------------------------------------------
// End-of-year recap
// ---------------------------------------------------------------------------

/** The year a recap run covers by default: the previous calendar year, since
 *  the EventBridge schedule fires in early January. */
export function defaultRecapYear(now: Date = new Date()): number {
  return now.getUTCFullYear() - 1;
}

/** Celebratory plain-text recap of a household's year of plant care. */
export function composeRecapEmail(
  review: YearInReview,
  plantNames: Map<string, string>
): { subject: string; text: string } {
  const subject = `Your ${review.year} plant care year in review 🌱`;
  const taskWord = review.totalCompletions === 1 ? 'task' : 'tasks';
  const lines: string[] = [
    `What a year! Your household completed ${review.totalCompletions} plant-care ${taskWord} in ${review.year}.`,
    '',
  ];
  if (review.byMember.length > 0) {
    lines.push('Who did the work:');
    for (const m of review.byMember) {
      lines.push(`  - ${m.name}: ${m.count}`);
    }
    lines.push('');
  }
  if (review.byTaskType.length > 0) {
    lines.push('By task type:');
    for (const t of review.byTaskType) {
      lines.push(`  - ${t.type}: ${t.count}`);
    }
    lines.push('');
  }
  if (review.topPlants.length > 0) {
    lines.push('Most pampered plants:');
    for (const p of review.topPlants.slice(0, RECAP_TOP_PLANTS)) {
      lines.push(
        `  - ${plantNames.get(p.plantId) ?? 'A former plant'}: ${p.count} ${p.count === 1 ? 'task' : 'tasks'}`
      );
    }
    lines.push('');
  }
  lines.push(
    `Thanks for keeping things growing — here's to an even greener ${review.year + 1}! 🌿`
  );
  return { subject, text: lines.join('\n') };
}

/**
 * Cheap point-read of one recipient's household-scoped annual recap marker.
 * Per-recipient markers are required here: with the former shared marker, one
 * dry-run or partial SES batch permanently suppressed every member's retry.
 */
async function alreadyRecappedThisYear(
  userId: string,
  householdId: string,
  year: number,
  now: Date
): Promise<boolean> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}`,
        SK: `RECAP#${year}#HOUSEHOLD#${householdId}`,
      },
    })
  );
  if (!result.Item) return false;
  if (result.Item.status !== 'sending') return true;
  return Number(result.Item.leaseExpiresAt ?? 0) > Math.floor(now.getTime() / 1000);
}

/**
 * Reserve a recipient's once-per-household, once-per-year slot before
 * delivery. Observed failures release it so only that recipient is retried.
 */
async function reserveYearRecapSlot(
  userId: string,
  householdId: string,
  year: number,
  now: Date
): Promise<string | null> {
  const reservationId = randomUUID();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${userId}`,
          SK: `RECAP#${year}#HOUSEHOLD#${householdId}`,
          entityType: 'RecapMarker',
          status: 'sending',
          reservationId,
          leaseExpiresAt: nowEpoch + DELIVERY_LEASE_SECONDS,
          ttl: nowEpoch + RECAP_MARKER_TTL_SECONDS,
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

async function releaseYearRecapSlot(
  userId: string,
  householdId: string,
  year: number,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}`,
        SK: `RECAP#${year}#HOUSEHOLD#${householdId}`,
      },
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}

async function finalizeYearRecapSlot(
  userId: string,
  householdId: string,
  year: number,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}`,
        SK: `RECAP#${year}#HOUSEHOLD#${householdId}`,
      },
      UpdateExpression:
        'SET #status = :sent, sentAt = :sentAt REMOVE leaseExpiresAt, reservationId',
      ConditionExpression: '#status = :sending AND reservationId = :reservationId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sent': 'sent',
        ':sending': 'sending',
        ':sentAt': new Date().toISOString(),
        ':reservationId': reservationId,
      },
    })
  );
}

/**
 * Send the year recap for ONE household to every member whose email channel
 * is enabled. Households with zero completions that year are skipped. Delivery
 * and dedupe are tracked per recipient, so an unconfigured SES sender or one
 * failed member never burns every household member's annual retry. Returns
 * how many recap emails went out.
 */
export async function recapHousehold(
  householdId: string,
  year: number,
  now: Date = new Date()
): Promise<number> {
  const review = await taskService.getYearInReview(householdId, year);
  if (review.totalCompletions === 0) return 0;

  // 'all' filter: a plant that died in December still earned its spot.
  const plantNames = new Map(
    (await plantService.getPlants(householdId, 'all')).map((p) => [p.id, p.name])
  );
  const { subject, text } = composeRecapEmail(review, plantNames);

  const members = await householdService.getHouseholdMembers(householdId);
  let sent = 0;
  for (const member of members) {
    const prefs = await notificationPrefs.getPreferences(member.userId);
    if (!prefs.email) continue;
    // The Jan 2 schedule is retried at several UTC hours for the same reason
    // as the weekly digest: respect each recipient's local quiet hours without
    // burning the annual marker.
    if (notificationPrefs.isInDndWindow(prefs, now)) continue;
    if (await alreadyRecappedThisYear(member.userId, householdId, year, now)) continue;
    const reservationId = await reserveYearRecapSlot(member.userId, householdId, year, now);
    if (!reservationId) continue;
    try {
      // Count only real deliveries; a dry-run (unconfigured SES) returns false.
      const delivered = await emailNotifier.sendEmail({ to: member.email, subject, text });
      if (delivered) {
        sent += 1;
        await finalizeYearRecapSlot(member.userId, householdId, year, reservationId).catch(
          (err) => {
            logger.warn(
              { err: (err as Error).message, householdId, userId: member.userId },
              'recap.reservation_finalize_failed'
            );
          }
        );
      } else {
        await releaseYearRecapSlot(member.userId, householdId, year, reservationId).catch((err) => {
          logger.warn(
            { err: (err as Error).message, householdId, userId: member.userId },
            'recap.reservation_cleanup_failed'
          );
        });
      }
    } catch (err) {
      await releaseYearRecapSlot(member.userId, householdId, year, reservationId).catch(
        (cleanupErr) => {
          logger.warn(
            { err: (cleanupErr as Error).message, householdId, userId: member.userId },
            'recap.reservation_cleanup_failed'
          );
        }
      );
      // A partial failure shouldn't abort the remaining members or burn this
      // recipient's slot; the next scheduled/manual run retries only them.
      logger.warn(
        { err: (err as Error).message, householdId, userId: member.userId },
        'recap.send_failed'
      );
    }
  }
  return sent;
}

/**
 * Yearly EventBridge scan across every household. Defaults to recapping the
 * previous calendar year (the schedule fires in early January).
 */
export async function runYearRecaps(
  year?: number,
  now: Date = new Date()
): Promise<{ households: number; sent: number; failed: number; year: number }> {
  const recapYear = year ?? defaultRecapYear(now);
  const ids = await householdService.listAllHouseholdIds();
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      sent += await recapHousehold(id, recapYear, now);
    } catch (err) {
      failed += 1;
      logger.warn({ err: (err as Error).message, householdId: id }, 'recap.household_failed');
    }
  }
  logger.info(
    { households: ids.length, sent, failed, year: recapYear, msg: 'recap.run_complete' },
    'recap.run_complete'
  );
  return { households: ids.length, sent, failed, year: recapYear };
}
