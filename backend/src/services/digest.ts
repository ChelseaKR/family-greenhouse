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
 * markers. The digest uses a per-user, per-ISO-week marker (one digest per
 * user per week no matter how many retries or manual triggers happen); the
 * recap uses a per-household, per-year marker held for ~60 days so a retried
 * yearly run can't double-send.
 *
 * Both emails are plain text (see emailNotifier — no HTML email yet) and are
 * sent directly through `emailNotifier.sendEmail` rather than the
 * `notifier.sendToUser` fan-out: these are email-only products, and a weekly/
 * yearly summary shouldn't be silently rerouted to SMS or suppressed by a DND
 * window aimed at real-time pings.
 */
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as plantService from './plantService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as emailNotifier from './emailNotifier.js';
import type { YearInReview } from './taskService.js';

/** Digest lists at most this many plants — it's a nudge, not an inventory. */
const TOP_PLANTS = 5;
// Weekly marker outlives its week by one day; DynamoDB TTL sweeps it.
const DIGEST_MARKER_TTL_SECONDS = 8 * 24 * 60 * 60;
// Recap marker held ~60 days so January retries can't double-send.
const RECAP_MARKER_TTL_SECONDS = 60 * 24 * 60 * 60;

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
 * The household's plants most at risk: every ACTIVE plant with at least one
 * overdue task, ranked by the max days-overdue across its tasks, capped at
 * the top 5. One due-window GSI1 query (cutoff = now ⇒ overdue only) plus
 * the active-plant read — the same shape the reminder scan uses.
 */
export async function computePlantsAtRisk(
  householdId: string,
  now: Date = new Date()
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
    const daysOverdue = Math.floor(
      (now.getTime() - new Date(task.nextDue).getTime()) / (24 * 60 * 60 * 1000)
    );
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

  return [...byPlant.values()].sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, TOP_PLANTS);
}

function overduePhrase(days: number): string {
  if (days <= 0) return 'ready for a little care today';
  return days === 1 ? 'waiting a day for some care' : `waiting ${days} days for some care`;
}

/** Plain-text weekly digest email body + subject. */
export function composeDigestEmail(atRisk: PlantAtRisk[]): { subject: string; text: string } {
  const subject =
    atRisk.length === 1
      ? 'Weekly digest: 1 plant could use some care'
      : `Weekly digest: ${atRisk.length} plants could use some care`;
  const lines = atRisk.map(
    (p, i) => `${i + 1}. ${p.plantName} — ${p.taskType} ${overduePhrase(p.daysOverdue)}`
  );
  const text = [
    'Your weekly Family Greenhouse check-in.',
    '',
    'A few plants could use some catch-up care (the ones waiting longest first):',
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
 * Conditionally claim this user's digest slot for the current ISO week.
 * Same pattern (and same failure-mode tradeoff) as the reminders daily
 * marker: claimed BEFORE sending, so a failed send costs one week's digest
 * instead of risking double-billing email on retries.
 */
async function claimWeeklyDigestSlot(userId: string, now: Date): Promise<boolean> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${userId}`,
          SK: `DIGEST#${isoWeekKey(now)}`,
          entityType: 'DigestMarker',
          sentAt: now.toISOString(),
          ttl: Math.floor(now.getTime() / 1000) + DIGEST_MARKER_TTL_SECONDS,
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
    if (!(await claimWeeklyDigestSlot(member.userId, now))) continue;
    await emailNotifier.sendEmail({ to: member.email, subject, text });
    sent += 1;
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
): Promise<{ households: number; sent: number }> {
  const ids = await householdService.listAllHouseholdIds();
  let sent = 0;
  for (const id of ids) {
    try {
      sent += await digestHousehold(id, now);
    } catch (err) {
      logger.warn({ err: (err as Error).message, householdId: id }, 'digest.household_failed');
    }
  }
  logger.info({ households: ids.length, sent, msg: 'digest.run_complete' }, 'digest.run_complete');
  return { households: ids.length, sent };
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
    for (const p of review.topPlants) {
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
 * Claim the household's once-per-year recap slot. Per-household (not
 * per-user): the recap is one shared artifact, so a retried run skips the
 * whole household rather than re-deciding per member.
 */
async function claimYearRecapSlot(householdId: string, year: number, now: Date): Promise<boolean> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `RECAP#${year}`,
          entityType: 'RecapMarker',
          sentAt: now.toISOString(),
          ttl: Math.floor(now.getTime() / 1000) + RECAP_MARKER_TTL_SECONDS,
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
 * Send the year recap for ONE household to every member whose email channel
 * is enabled. Households with zero completions that year are skipped (before
 * the marker is claimed, so a quiet year doesn't burn the slot). Returns how
 * many recap emails went out.
 */
export async function recapHousehold(
  householdId: string,
  year: number,
  now: Date = new Date()
): Promise<number> {
  const review = await taskService.getYearInReview(householdId, year);
  if (review.totalCompletions === 0) return 0;
  if (!(await claimYearRecapSlot(householdId, year, now))) return 0;

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
    try {
      await emailNotifier.sendEmail({ to: member.email, subject, text });
      sent += 1;
    } catch (err) {
      // The household marker is already claimed; a partial failure shouldn't
      // abort the remaining members' recaps.
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
): Promise<{ households: number; sent: number; year: number }> {
  const recapYear = year ?? defaultRecapYear(now);
  const ids = await householdService.listAllHouseholdIds();
  let sent = 0;
  for (const id of ids) {
    try {
      sent += await recapHousehold(id, recapYear, now);
    } catch (err) {
      logger.warn({ err: (err as Error).message, householdId: id }, 'recap.household_failed');
    }
  }
  logger.info(
    { households: ids.length, sent, year: recapYear, msg: 'recap.run_complete' },
    'recap.run_complete'
  );
  return { households: ids.length, sent, year: recapYear };
}
