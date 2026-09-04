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
 * This file owns DELIVERY: the scan, the dedupe markers, the per-recipient
 * locale and unsubscribe token, the send loop. What the digest actually SAYS
 * lives in `services/digestReport.ts`.
 *
 * Spam control mirrors services/reminders.ts: TTL'd conditional-Put dedupe
 * markers. The digest uses a per-user, per-household, per-ISO-week marker; the
 * recap uses a per-user, per-household, per-year marker held for ~60 days.
 * That scope skips successful retries without hiding a second household's
 * distinct summary.
 *
 * Both emails are sent directly through `emailNotifier.sendEmail` rather than
 * the `notifier.sendToUser` fan-out: these are email-only products, and a
 * weekly/yearly summary shouldn't be silently rerouted to SMS or suppressed by
 * a DND window aimed at real-time pings. Both carry a `List-Unsubscribe`
 * header and an HTML part (ADR 0021).
 */
import { randomUUID } from 'node:crypto';
import { PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as plantService from './plantService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as emailNotifier from './emailNotifier.js';
import * as digestReport from './digestReport.js';
import { mintUnsubscribeToken, type EmailCategory } from './email/capability.js';
import { t, tn, formatYear, type EmailLocale } from './email/catalog.js';
import { analyticsUrl, plantUrl, settingsUrl, unsubscribeUrl } from './email/links.js';
import { householdLocaleFrom, resolveEmailLocale } from './email/locale.js';
import { renderEmail, type EmailBlock } from './email/template.js';
import type { HouseholdMember } from '../models/types.js';
import type { YearInReview } from './taskService.js';

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

/**
 * Per-recipient locale + unsubscribe capability, resolved once per member.
 *
 * `localeSource` is logged with the send so a fallback to English is
 * countable rather than silent, and `unsubscribeUrl` is null (rather than a
 * guessed URL) when `PUBLIC_API_URL` is unset — a 404ing unsubscribe link is
 * worse for deliverability than no `List-Unsubscribe` header at all.
 */
async function recipientContext(
  member: HouseholdMember,
  storedLocale: string,
  household: EmailLocale | null,
  category: EmailCategory
): Promise<{ locale: EmailLocale; localeSource: string; unsubscribeUrl: string | null }> {
  const { locale, source } = resolveEmailLocale(storedLocale, household);
  const minted = await mintUnsubscribeToken(member.userId, category);
  let url: string | null = null;
  if (minted.status === 'ok') {
    const built = unsubscribeUrl(minted.token);
    url = built ? `${built}&lang=${locale}` : null;
  }
  if (!url) {
    logger.warn(
      { userId: member.userId, category, msg: 'digest.unsubscribe_link_unavailable' },
      'digest.unsubscribe_link_unavailable'
    );
  }
  return { locale, localeSource: source, unsubscribeUrl: url };
}

/**
 * Read every member's preferences once, in join order, and derive the
 * household's prevailing email locale from them. One pass, no extra reads: the
 * send loop needs each member's prefs anyway.
 */
async function readMemberPrefs(members: HouseholdMember[]): Promise<{
  ordered: HouseholdMember[];
  prefs: Map<string, notificationPrefs.NotificationPreferences>;
  householdLocale: EmailLocale | null;
}> {
  const ordered = [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  const prefs = new Map<string, notificationPrefs.NotificationPreferences>();
  for (const member of ordered) {
    prefs.set(member.userId, await notificationPrefs.getPreferences(member.userId));
  }
  const householdLocale = householdLocaleFrom(
    ordered.map((member) => prefs.get(member.userId)?.emailLocale)
  );
  return { ordered, prefs, householdLocale };
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
 * Send the weekly digest for ONE household.
 *
 * The old shape was `if (atRisk.length === 0) return 0` before reading
 * anything else, which meant a broken query and a healthy week were the same
 * thing to the recipient: no email. The help copy actively teaches users to
 * read silence as health. So now:
 *
 *   - a FAILED at-risk read still sends, carrying a line that says we could
 *     not check and that an empty list is not an all-clear;
 *   - a genuinely quiet week (nothing overdue, nothing failed) is skipped and
 *     LOGGED with its reason, so silence is at least observable to us;
 *   - the report is gathered once and rendered per recipient, because the
 *     greeting, the language and the unsubscribe token are per person.
 *
 * A member who is away (an active vacation window) receives nothing: that is
 * what vacation mode is for, and their plants are named in the cover's copy.
 *
 * Each member receives it only when their email channel AND the weeklyDigest
 * pref are on, at most once per ISO week. Returns how many digests were sent.
 */
export async function digestHousehold(
  householdId: string,
  now: Date = new Date()
): Promise<number> {
  const report = await digestReport.gatherDigestReport(householdId, now);
  if (!digestReport.digestIsWorthSending(report)) {
    logger.info(
      {
        householdId,
        atRisk: report.atRisk.status,
        msg: 'digest.skipped_nothing_to_say',
      },
      'digest.skipped_nothing_to_say'
    );
    return 0;
  }

  const members = await householdService.getHouseholdMembers(householdId);
  const { ordered, prefs: allPrefs, householdLocale } = await readMemberPrefs(members);

  let sent = 0;
  for (const member of ordered) {
    const prefs = allPrefs.get(member.userId);
    if (!prefs || !prefs.email || !prefs.weeklyDigest) continue;
    // Vacation mode means "do not bother me". Their tasks are already routed
    // to the covering member, who is named on the row.
    if (report.awayUserIds.has(member.userId)) continue;
    // EventBridge retries at several UTC hours on Monday. Skip (without
    // claiming the weekly slot) during this recipient's local quiet window;
    // the next invocation can deliver once they are awake.
    if (notificationPrefs.isInDndWindow(prefs, now)) continue;
    // Cheap pre-check skips an already-digested member so a same-week retry
    // never re-emails.
    if (await alreadyDigestedThisWeek(member.userId, householdId, now)) continue;
    const reservationId = await reserveWeeklyDigestSlot(member.userId, householdId, now);
    if (!reservationId) continue;

    const context = await recipientContext(
      member,
      prefs.emailLocale,
      householdLocale,
      'weekly_digest'
    );
    const { subject, text, html, headers } = digestReport.composeDigestEmail(report, {
      userId: member.userId,
      name: member.name,
      locale: context.locale,
      unsubscribeUrl: context.unsubscribeUrl,
    });

    // Isolate each member's send. A false dry-run or provider exception
    // releases the reservation, so the next run retries that recipient.
    let delivered: boolean;
    try {
      delivered = await emailNotifier.sendEmail({ to: member.email, subject, text, html, headers });
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
      logger.info(
        {
          householdId,
          userId: member.userId,
          locale: context.locale,
          localeSource: context.localeSource,
          msg: 'digest.sent',
        },
        'digest.sent'
      );
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

/**
 * The plant names a recap needs, or an honest "we could not look them up".
 *
 * `'A former plant'` used to stand in for a missing lookup, which announced a
 * *fact about the plant's lifecycle* — that it is gone — on the strength of a
 * failed read. `plantNames` comes from `getPlants(householdId, 'all')`; any
 * plant absent from that read for a non-throwing reason was reported to the
 * household as dead or given away.
 */
export type RecapPlantNames =
  { status: 'ok'; names: Map<string, string> } | { status: 'unavailable' };

/** Recap email for a household's year of plant care, HTML + text. */
export function composeRecapEmail(
  review: YearInReview,
  plantNames: RecapPlantNames,
  recipient: { name: string | null; locale: EmailLocale; unsubscribeUrl: string | null },
  householdName: string | null = null
): { subject: string; text: string; html: string; headers?: Record<string, string> } {
  const locale = recipient.locale;
  const year = formatYear(locale, review.year);
  const blocks: EmailBlock[] = [
    {
      kind: 'text',
      text: tn(locale, 'recap.total', review.totalCompletions, { year }),
    },
  ];

  if (review.byMember.length > 0) {
    blocks.push({ kind: 'heading', text: t(locale, 'recap.whoHeading') });
    for (const member of review.byMember) {
      blocks.push({
        kind: 'row',
        // A completion row with no display name used to print the raw Cognito
        // sub under this heading, as if a UUID were a person.
        title: member.name ?? t(locale, 'recap.memberUnknown'),
        lines: [tn(locale, 'recap.count', member.count)],
      });
    }
  }

  if (review.byTaskType.length > 0) {
    blocks.push({ kind: 'heading', text: t(locale, 'recap.typeHeading') });
    for (const entry of review.byTaskType) {
      const label =
        entry.type === 'water' ||
        entry.type === 'fertilize' ||
        entry.type === 'prune' ||
        entry.type === 'repot'
          ? t(locale, `taskType.${entry.type}`)
          : // A custom task type stores the user's own label; an empty one is
            // a missing label, not a task literally named "custom".
            entry.type.trim() || t(locale, 'taskType.custom');
      blocks.push({ kind: 'row', title: label, lines: [tn(locale, 'recap.count', entry.count)] });
    }
  }

  if (review.topPlants.length > 0) {
    blocks.push({ kind: 'heading', text: t(locale, 'recap.plantsHeading') });
    if (plantNames.status === 'unavailable') {
      blocks.push({ kind: 'notice', text: t(locale, 'recap.plantsUnavailable') });
    }
    for (const plant of review.topPlants.slice(0, RECAP_TOP_PLANTS)) {
      const name =
        plantNames.status === 'ok'
          ? (plantNames.names.get(plant.plantId) ?? t(locale, 'recap.plantUnknown'))
          : t(locale, 'recap.plantUnknown');
      blocks.push({
        kind: 'row',
        title: name,
        href: plantUrl(plant.plantId),
        lines: [tn(locale, 'recap.count', plant.count)],
      });
    }
  }

  blocks.push({ kind: 'button', label: t(locale, 'recap.cta'), href: analyticsUrl() });
  blocks.push({
    kind: 'text',
    text: t(locale, 'recap.closing', { year: formatYear(locale, review.year + 1) }),
    tone: 'muted',
  });

  const links = [{ label: t(locale, 'footer.manage'), href: settingsUrl() }];
  if (recipient.unsubscribeUrl) {
    links.push({ label: t(locale, 'footer.unsubscribe'), href: recipient.unsubscribeUrl });
  }

  const { html, text } = renderEmail({
    locale,
    title: t(locale, 'recap.title', { year }),
    preheader: t(locale, 'recap.preheader'),
    blocks,
    footer: {
      reason: householdName
        ? t(locale, 'footer.reason.household', { household: householdName })
        : t(locale, 'footer.reason.householdGeneric'),
      safety: t(locale, 'footer.safety'),
      links,
    },
  });

  return {
    subject: t(locale, 'recap.subject', { year }),
    text,
    html,
    headers: recipient.unsubscribeUrl
      ? {
          'List-Unsubscribe': `<${recipient.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined,
  };
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
 * AND `yearRecap` pref are on. Households with zero completions that year are
 * skipped. Delivery and dedupe are tracked per recipient, so an unconfigured
 * SES sender or one failed member never burns every household member's annual
 * retry. Returns how many recap emails went out.
 *
 * `yearRecap` is new. The recap used to be gated on `prefs.email` alone, so a
 * user who explicitly unticked "Weekly plant digest" — the only summary
 * opt-out the UI offered — still received the annual summary every January.
 */
export async function recapHousehold(
  householdId: string,
  year: number,
  now: Date = new Date()
): Promise<number> {
  const review = await taskService.getYearInReview(householdId, year);
  if (review.totalCompletions === 0) return 0;

  // 'all' filter: a plant that died in December still earned its spot. A
  // FAILED read is reported as such rather than letting every row render an
  // "A former plant" label that asserts those plants are gone.
  let plantNames: RecapPlantNames;
  try {
    plantNames = {
      status: 'ok',
      names: new Map((await plantService.getPlants(householdId, 'all')).map((p) => [p.id, p.name])),
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'recap.plant_names_read_failed' },
      'recap.plant_names_read_failed'
    );
    plantNames = { status: 'unavailable' };
  }

  const nameResult = await digestReport.readHouseholdName(householdId);
  const householdName = nameResult.status === 'ok' ? nameResult.name : null;

  const members = await householdService.getHouseholdMembers(householdId);
  const { ordered, prefs: allPrefs, householdLocale } = await readMemberPrefs(members);
  let sent = 0;
  for (const member of ordered) {
    const prefs = allPrefs.get(member.userId);
    if (!prefs || !prefs.email || !prefs.yearRecap) continue;
    // The Jan 2 schedule is retried at several UTC hours for the same reason
    // as the weekly digest: respect each recipient's local quiet hours without
    // burning the annual marker.
    if (notificationPrefs.isInDndWindow(prefs, now)) continue;
    if (await alreadyRecappedThisYear(member.userId, householdId, year, now)) continue;
    const reservationId = await reserveYearRecapSlot(member.userId, householdId, year, now);
    if (!reservationId) continue;
    const context = await recipientContext(
      member,
      prefs.emailLocale,
      householdLocale,
      'year_recap'
    );
    const { subject, text, html, headers } = composeRecapEmail(
      review,
      plantNames,
      {
        name: member.name,
        locale: context.locale,
        unsubscribeUrl: context.unsubscribeUrl,
      },
      householdName
    );
    try {
      // Count only real deliveries; a dry-run (unconfigured SES) returns false.
      const delivered = await emailNotifier.sendEmail({
        to: member.email,
        subject,
        text,
        html,
        headers,
      });
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
