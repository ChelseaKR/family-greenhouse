/**
 * The household emails — the four messages this product sends *about the
 * people in a household* rather than about one person's plants.
 *
 * The email audit's structural finding was that every email the app sends is
 * addressed to an individual about plants, and not one is about the household
 * as a group; the collaborative core that `docs/strategy-review.md` calls the
 * moat had no email surface at all. These close that:
 *
 *   1. `member_joined`  — the invite you sent was accepted (services/inviteEmail.ts
 *                         sends the invite; this closes the loop).
 *   2. `up_for_grabs`   — upcoming tasks nobody has claimed, scoped strictly
 *                         OUTSIDE the daily reminder's 24-hour window so the
 *                         two can never name the same task on the same day
 *                         (see REMINDER_DUE_WINDOW_MS). Unclaimed work is the
 *                         bystander-effect shape the product exists to
 *                         prevent; this is the half of it nobody is being told
 *                         about at all.
 *   3. `coverage`       — a `VacationWindow` named you as someone's cover.
 *                         Today the cover finds out as a parenthetical inside
 *                         a reminder, on the day.
 *   4. `care_credit`    — someone did a task that had your name on it.
 *
 * ## Why there is a queue
 *
 * Three of the four fire on a one-shot event (a join, a vacation window, a
 * completion). A one-shot send has nowhere to retry and no way to respect a
 * quiet window: sending during DND breaks the promise, and skipping loses the
 * message. So every household email is written to a small per-recipient row
 * first and delivered by `flushUser`, which the hourly reminder scan already in
 * production calls for each member. That gives all four:
 *
 *   - **DND for free.** A row whose owner is inside their quiet window is left
 *     alone and picked up by a later hourly pass — the same design the weekly
 *     digest uses across its four Monday passes.
 *   - **Retry for free.** A dry run or an SES exception leaves the row
 *     `pending`. `emailNotifier.sendEmail` returning `false` (SES unconfigured)
 *     is not a delivery and never finalizes a row.
 *   - **Dedupe for free.** The row's sort key IS the dedupe marker, and a
 *     delivered row is kept as `sent` until its TTL rather than deleted, so a
 *     repeated trigger cannot produce a second email.
 *   - **Roll-up for free.** `care_credit` appends to one row per recipient per
 *     local day, so a household that covers ten tasks in an afternoon produces
 *     one email, not ten. `up_for_grabs` is keyed per ISO week for the same
 *     reason: it is the one kind whose trigger is a standing state rather than
 *     an event, so it is the one that could otherwise repeat daily.
 *
 * A row is never a claim of delivery: `sent` means SES accepted the message,
 * which the audit correctly notes is not the same thing. Bounce handling lives
 * with the SES configuration set (a separate branch).
 *
 * ## Honesty rules applied here
 *
 * `docs/adr/0010-settled-read-states.md`: a read that did not settle is a
 * named unknown, never a plausible value.
 *
 *   - A member row we could not read yields `null` for the name, and
 *     `services/emailCopy.ts` writes a sentence that says the name is missing.
 *     It never becomes "a housemate" (`reminders.ts`) or "A former plant"
 *     (`digest.ts` recap).
 *   - A household with unclaimed upcoming tasks but an empty active-plant read
 *     is reported as `unknown`, not as "nothing to do" — the exact hole the
 *     audit found in `computePlantsAtRisk`, where a non-throwing short read
 *     makes a broken week and a healthy week identical.
 *   - `runHouseholdEmails` returns `failed` and `unknown` counts alongside
 *     `sent`, so a run where every household broke cannot read as a quiet week.
 */
import { DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { HouseholdMember, Task } from '../models/types.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as plantService from './plantService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as emailNotifier from './emailNotifier.js';
import * as scheduledFanOut from './scheduledFanOut.js';
import {
  composeCareCreditEmail,
  composeCoverageEmail,
  composeMemberJoinedEmail,
  composeUpForGrabsEmail,
  daysUntilDue,
  taskLabel,
  type ComposedEmail,
  type EmailLocale,
} from './emailCopy.js';
import { resolveEmailLocale } from './email/locale.js';

export const QUEUE_SK_PREFIX = 'HHEMAIL#';

/** A queued email that has not been delivered within this window is dropped
 *  rather than sent stale — "Sam is away from the 3rd" is worse than useless
 *  on the 6th. The drop is logged; it is never silent. */
const QUEUE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
/** DynamoDB TTL. Comfortably past the max age so a `sent` row keeps doing its
 *  job as a dedupe marker for the rest of the day it belongs to. */
const QUEUE_TTL_SECONDS = 4 * 24 * 60 * 60;

/**
 * The daily reminder's due window (`reminders.DUE_WINDOW_MS`), duplicated here
 * as the boundary that keeps the two emails disjoint.
 *
 * `remindHousehold` queries `nextDue <= now + 24h`, which includes *everything*
 * already overdue, and #427 gives that email an explicit "Up for grabs" section
 * for the unclaimed rows in it. So a dedicated email about unclaimed overdue
 * tasks would be pure duplication: every recipient would get the same task
 * named twice on the same morning.
 *
 * This email therefore takes the other side of the line — unclaimed tasks the
 * reminder is *not* mentioning at all, because they are not due yet. That is
 * the long tail nobody is being told about, and it is the more on-thesis half:
 * asking for a hand before anything is late is the anti-nag version of the ask.
 *
 * Change this one constant and the two overlap; nothing else encodes the split.
 */
const REMINDER_DUE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * How far past the reminder's window this email looks.
 *
 * Deliberately equal to the send cadence (one per recipient per ISO week), so
 * the two surfaces hand off with no gap: a task further out than this is picked
 * up by a later weekly pass while still unclaimed, and one that crosses inside
 * `REMINDER_DUE_WINDOW_MS` before the next pass is picked up by the daily
 * reminder that morning. No unclaimed task can fall between them.
 */
const UP_FOR_GRABS_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** How many tasks the up-for-grabs email NAMES. It always states the real
 *  total — the digest's docstring records what happens when a display cap
 *  becomes the reported count. */
const UP_FOR_GRABS_LIST_LIMIT = 5;
/** How many covered tasks one credit email lists before it starts counting the
 *  rest as "and N more". */
const CARE_CREDIT_LIST_LIMIT = 8;
/** Tasks named in a coverage email. Beyond this the email points at the app. */
const COVERAGE_LIST_LIMIT = 10;

export type HouseholdEmailKind = 'member_joined' | 'up_for_grabs' | 'coverage' | 'care_credit';

/** Which per-user toggle governs each kind. Every household email is
 *  individually switchable; before these, `weeklyDigest` was the product's
 *  only per-email control. */
const PREF_KEY: Record<HouseholdEmailKind, notificationPrefs.HouseholdEmailPrefKey> = {
  member_joined: 'memberJoined',
  up_for_grabs: 'taskUpForGrabs',
  coverage: 'coverageUpdates',
  care_credit: 'careCredit',
};

interface QueueRow {
  PK: string;
  SK: string;
  kind: HouseholdEmailKind;
  householdId: string;
  email: string;
  /** Kind-specific payload fragments, each a JSON string. One element for the
   *  single-shot kinds; `care_credit` appends. A DDB list of strings rather
   *  than a nested map because `list_append` on a top-level attribute avoids
   *  the overlapping-document-path restriction that a nested one would hit. */
  items: string[];
  /** Real events beyond the ones in `items`. Counted, never dropped silently. */
  overflow?: number;
  status: 'pending' | 'sent';
  createdAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Reads that report their own failures
// ---------------------------------------------------------------------------

type Read<T> = { status: 'found'; value: T } | { status: 'absent' } | { status: 'unknown' };

/**
 * A member row, with "the row is not there" and "the read did not settle" kept
 * apart. Both render the same way in copy (we cannot name this person), but
 * only one of them is a bug, and the log line says which.
 */
async function readMember(householdId: string, userId: string): Promise<Read<HouseholdMember>> {
  try {
    const member = await householdService.getMemberByUserId(householdId, userId);
    return member ? { status: 'found', value: member } : { status: 'absent' };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, userId },
      'household_email.member_read_unknown'
    );
    return { status: 'unknown' };
  }
}

async function readHouseholdName(householdId: string): Promise<Read<string>> {
  try {
    const household = await householdService.getHousehold(householdId);
    const name = household?.name?.trim();
    return name ? { status: 'found', value: name } : { status: 'absent' };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId },
      'household_email.household_read_unknown'
    );
    return { status: 'unknown' };
  }
}

/** A display name, or null when we do not have one. Never a stand-in noun. */
function nameOf(read: Read<HouseholdMember>): string | null {
  return read.status === 'found' ? read.value.name?.trim() || null : null;
}

/** The read's value, or null. `null` reaches the copy layer as an acknowledged
 *  unknown; it is never rendered as though it were a fact. */
function valueOrNull<T>(read: Read<T>): T | null {
  return read.status === 'found' ? read.value : null;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Same resolution as `reminders.frontendUrl`, duplicated rather than exported
 *  from there so this branch does not edit the reminder path. */
export function appLink(path: string): string {
  const base = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';
  return new URL(path, base).toString();
}

const settingsUrl = () => appLink('/settings');
const plantUrl = (plantId: string) => appLink(`/plants/${encodeURIComponent(plantId)}`);

// ---------------------------------------------------------------------------
// Queue writes
// ---------------------------------------------------------------------------

function queueKey(userId: string, dedupeKey: string): { PK: string; SK: string } {
  return { PK: `USER#${userId}`, SK: `${QUEUE_SK_PREFIX}${dedupeKey}` };
}

export type EnqueueResult = 'queued' | 'duplicate' | 'suppressed' | 'counted';

/**
 * Decide whether this recipient wants this email at all.
 *
 * Returns the prefs when they do, so the caller can key its dedupe marker on
 * the recipient's own local date (their timezone, not the Lambda's) and render
 * in their own language later.
 */
async function eligible(
  userId: string,
  kind: HouseholdEmailKind
): Promise<notificationPrefs.NotificationPreferences | null> {
  const prefs = await notificationPrefs.getPreferences(userId);
  if (!prefs.email) return null;
  if (!prefs[PREF_KEY[kind]]) return null;
  return prefs;
}

/**
 * Write (or extend) one recipient's queued email.
 *
 * The conditional guard does two jobs at once: a row that has already been
 * delivered is never reopened, and an accumulating roll-up stops growing at
 * `maxItems` — the surplus becomes an `overflow` count so the email can say
 * "and 4 more" truthfully instead of quietly listing five of nine.
 */
async function enqueue(params: {
  userId: string;
  email: string;
  householdId: string;
  kind: HouseholdEmailKind;
  dedupeKey: string;
  item: unknown;
  /** How many items one row may carry. `1` for the single-shot kinds. */
  maxItems: number;
  /** True only for the roll-up kinds, where an item arriving after the row is
   *  full or already delivered is still a real event and must be counted. */
  accumulate: boolean;
  now: Date;
}): Promise<EnqueueResult> {
  const { userId, email, householdId, kind, dedupeKey, item, maxItems, accumulate, now } = params;
  const key = queueKey(userId, dedupeKey);
  const nowIso = now.toISOString();
  const base = {
    ':kind': kind,
    ':householdId': householdId,
    ':email': email,
    ':pending': 'pending' as const,
    ':now': nowIso,
    ':expiresAt': new Date(now.getTime() + QUEUE_MAX_AGE_MS).toISOString(),
    ':ttl': Math.floor(now.getTime() / 1000) + QUEUE_TTL_SECONDS,
    ':entityType': 'HouseholdEmailQueueItem',
  };
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression:
          'SET entityType = :entityType, #kind = :kind, householdId = :householdId, ' +
          'email = :email, userId = :userId, ' +
          '#status = if_not_exists(#status, :pending), ' +
          'createdAt = if_not_exists(createdAt, :now), ' +
          'expiresAt = if_not_exists(expiresAt, :expiresAt), ' +
          '#ttl = if_not_exists(#ttl, :ttl), ' +
          'items = list_append(if_not_exists(items, :empty), :one)',
        ConditionExpression:
          '(attribute_not_exists(PK) OR #status = :pending) AND ' +
          '(attribute_not_exists(items) OR size(items) < :max)',
        ExpressionAttributeNames: { '#kind': 'kind', '#status': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ...base,
          ':userId': userId,
          ':empty': [] as string[],
          ':one': [JSON.stringify(item)],
          ':max': maxItems,
        },
      })
    );
    return 'queued';
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  // A single-shot kind reaching here has already been queued or delivered for
  // this dedupe key, which is exactly what the key is for.
  if (!accumulate) return 'duplicate';
  // Either the row is already delivered, or the roll-up is full. Count the
  // surplus onto a still-pending row; a delivered one rejects that too, and
  // that is the duplicate case.
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'ADD overflow :one',
        ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':one': 1, ':pending': 'pending' },
      })
    );
    return 'counted';
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'duplicate';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface MemberJoinedItem {
  memberName: string | null;
  householdName: string | null;
  invitedByRecipient: boolean;
  householdUrl: string;
}

interface UpForGrabsItem {
  householdName: string | null;
  totalCount: number;
  tasks: Array<{
    plantId: string;
    plantName: string;
    type: string;
    customType: string | null;
    nextDue: string;
  }>;
}

interface CoverageItem {
  awayName: string | null;
  householdName: string | null;
  startDate: string;
  endDate: string;
  /** null means the task read did not settle — see composeCoverageEmail. */
  tasks: Array<{
    plantId: string;
    plantName: string;
    type: string;
    customType: string | null;
    nextDue: string;
  }> | null;
}

interface CareCreditItemPayload {
  plantId: string;
  plantName: string;
  type: string;
  customType: string | null;
  actorName: string | null;
  note: string | null;
}

function parseItems<T>(items: string[]): T[] {
  const out: T[] = [];
  for (const raw of items) {
    try {
      out.push(JSON.parse(raw) as T);
    } catch (err) {
      // A payload we cannot parse is dropped from the body, and the row's
      // `overflow` is not adjusted to hide it — the reader sees a count that
      // does not match the list, which is the honest outcome.
      logger.warn({ err: (err as Error).message }, 'household_email.item_parse_failed');
    }
  }
  return out;
}

/** Turn a queued row into an email, in the recipient's language. Pure apart
 *  from the URL base, and exported so every kind's copy is unit-testable
 *  without a queue or SES. */
export function renderQueued(
  row: Pick<QueueRow, 'kind' | 'items' | 'overflow'>,
  locale: EmailLocale,
  now: Date
): ComposedEmail | null {
  const settings = settingsUrl();
  switch (row.kind) {
    case 'member_joined': {
      const [item] = parseItems<MemberJoinedItem>(row.items);
      if (!item) return null;
      return composeMemberJoinedEmail(
        {
          memberName: item.memberName,
          householdName: item.householdName,
          recipientSentTheInvite: item.invitedByRecipient,
          householdUrl: item.householdUrl,
          settingsUrl: settings,
        },
        locale
      );
    }
    case 'up_for_grabs': {
      const [item] = parseItems<UpForGrabsItem>(row.items);
      if (!item) return null;
      return composeUpForGrabsEmail(
        {
          householdName: item.householdName,
          totalCount: item.totalCount,
          tasks: item.tasks.map((t) => ({
            plantName: t.plantName,
            taskLabel: taskLabel(t, locale),
            daysUntilDue: daysUntilDue(t.nextDue, now),
            plantUrl: plantUrl(t.plantId),
          })),
          claimUrl: appLink('/tasks?filter=overdue'),
          settingsUrl: settings,
        },
        locale
      );
    }
    case 'coverage': {
      const [item] = parseItems<CoverageItem>(row.items);
      if (!item) return null;
      return composeCoverageEmail(
        {
          awayName: item.awayName,
          householdName: item.householdName,
          startDate: item.startDate,
          endDate: item.endDate,
          tasks:
            item.tasks === null
              ? null
              : item.tasks.map((t) => ({
                  plantName: t.plantName,
                  taskLabel: taskLabel(t, locale),
                  dueDate: t.nextDue,
                  plantUrl: plantUrl(t.plantId),
                })),
          tasksUrl: appLink('/tasks'),
          settingsUrl: settings,
        },
        locale
      );
    }
    case 'care_credit': {
      const items = parseItems<CareCreditItemPayload>(row.items);
      if (items.length === 0) return null;
      return composeCareCreditEmail(
        {
          items: items.map((i) => ({
            plantName: i.plantName,
            taskLabel: taskLabel(i, locale),
            actorName: i.actorName,
            note: i.note,
            plantUrl: plantUrl(i.plantId),
          })),
          moreCount: row.overflow ?? 0,
          activityUrl: appLink('/dashboard'),
          settingsUrl: settings,
        },
        locale
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

export interface FlushSummary {
  sent: number;
  deferred: number;
  expired: number;
  suppressed: number;
  failed: number;
}

const EMPTY_FLUSH: FlushSummary = { sent: 0, deferred: 0, expired: 0, suppressed: 0, failed: 0 };

async function markSent(key: { PK: string; SK: string }, now: Date): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET #status = :sent, sentAt = :sentAt',
      ConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sent': 'sent',
        ':pending': 'pending',
        ':sentAt': now.toISOString(),
      },
    })
  );
}

async function discard(key: { PK: string; SK: string }): Promise<void> {
  await dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));
}

/**
 * Deliver one user's queued household emails.
 *
 * Called for every member on the hourly reminder pass. A user with nothing
 * queued costs one small Query and returns immediately, which is why this can
 * ride an existing scan rather than needing a schedule of its own.
 */
export async function flushUser(userId: string, now: Date = new Date()): Promise<FlushSummary> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': QUEUE_SK_PREFIX },
    })
  );
  const rows = (result.Items ?? []) as unknown as QueueRow[];
  const pending = rows.filter((row) => row.status === 'pending');
  if (pending.length === 0) return { ...EMPTY_FLUSH };

  const summary: FlushSummary = { ...EMPTY_FLUSH };
  const prefs = await notificationPrefs.getPreferences(userId);
  // Language comes from the canonical resolver in `services/email/locale.ts`.
  // This used to call a `preferredEmailLocale` helper that probed the record
  // for a field named `locale`; the field is `emailLocale`, so the probe was
  // never true and every household email went out in English — including to
  // users who had explicitly chosen Spanish in Settings, for copy that has a
  // complete Spanish translation sitting in emailCopy.ts.
  //
  // The pure overload, not `resolveEmailLocaleForUser`: `prefs` is already in
  // hand, so the accessor's own read would be a second point read per user per
  // hourly pass. The household step is passed `null` for the same reason — it
  // is a member fan-out, and this runs for every member every hour. `digest.ts`
  // resolves the household's language once per run, which is where that cost
  // belongs. `source` is logged so an English send to somebody who has never
  // chosen is a countable event rather than an invisible one.
  const { locale, source: localeSource } = resolveEmailLocale(prefs.emailLocale, null);
  const inDnd = notificationPrefs.isInDndWindow(prefs, now);

  for (const row of pending) {
    const key = { PK: row.PK, SK: row.SK };
    if (Date.parse(row.expiresAt) <= now.getTime()) {
      summary.expired += 1;
      logger.info(
        { userId, householdId: row.householdId, kind: row.kind, msg: 'household_email.expired' },
        'household_email.expired'
      );
      await discard(key);
      continue;
    }
    // Preferences are re-read at send time, not trusted from enqueue time: a
    // user who switches an email off should not receive one already queued.
    if (!prefs.email || !prefs[PREF_KEY[row.kind]]) {
      summary.suppressed += 1;
      await discard(key);
      continue;
    }
    if (inDnd) {
      summary.deferred += 1;
      continue;
    }
    const composed = renderQueued(row, locale, now);
    if (!composed) {
      // Nothing renderable survived — dropping it is right, but it is a bug,
      // so it is logged as one rather than counted as a send.
      summary.failed += 1;
      logger.warn(
        { userId, householdId: row.householdId, kind: row.kind },
        'household_email.render_empty'
      );
      await discard(key);
      continue;
    }
    let delivered: boolean;
    try {
      delivered = await emailNotifier.sendEmail({
        to: row.email,
        subject: composed.subject,
        text: composed.text,
      });
    } catch (err) {
      summary.failed += 1;
      logger.warn(
        { err: (err as Error).message, userId, householdId: row.householdId, kind: row.kind },
        'household_email.send_failed'
      );
      continue;
    }
    if (!delivered) {
      // A dry run (SES unconfigured) is not a delivery. Leave the row pending
      // so a configured environment still sends it.
      summary.failed += 1;
      continue;
    }
    summary.sent += 1;
    logger.info(
      {
        userId,
        householdId: row.householdId,
        kind: row.kind,
        locale,
        localeSource,
        msg: 'household_email.sent',
      },
      'household_email.sent'
    );
    try {
      await markSent(key, now);
    } catch (err) {
      // SES already has the message. Never delete or reopen the row here —
      // that would guarantee a duplicate on the next pass.
      logger.warn(
        { err: (err as Error).message, userId, kind: row.kind },
        'household_email.finalize_failed'
      );
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 2. Someone joined your household
// ---------------------------------------------------------------------------

/**
 * Tell the household that an invite was accepted.
 *
 * Goes to every existing member who wants it, with an extra line for whoever
 * minted the invite — the audit's point was that "the person who sent the
 * invite is never told it was accepted", and the roadmap measures exactly this
 * step (`invite_sent → invite_accepted`). Best-effort throughout: joining a
 * household must never fail because an email could not be queued.
 */
export async function notifyMemberJoined(
  params: { householdId: string; joinedUserId: string; invitedBy?: string | null },
  now: Date = new Date()
): Promise<number> {
  const { householdId, joinedUserId, invitedBy } = params;
  const joined = await readMember(householdId, joinedUserId);
  const memberName = nameOf(joined);
  const householdName = valueOrNull(await readHouseholdName(householdId));
  const members = await householdService.getHouseholdMembers(householdId);
  const householdUrl = appLink('/household');

  let queued = 0;
  for (const member of members) {
    if (member.userId === joinedUserId) continue;
    if (!member.email) continue;
    const prefs = await eligible(member.userId, 'member_joined');
    if (!prefs) continue;
    const outcome = await enqueue({
      userId: member.userId,
      email: member.email,
      householdId,
      kind: 'member_joined',
      dedupeKey: `member_joined#${householdId}#${joinedUserId}`,
      item: {
        memberName,
        householdName,
        invitedByRecipient: Boolean(invitedBy) && invitedBy === member.userId,
        householdUrl,
      } satisfies MemberJoinedItem,
      maxItems: 1,
      accumulate: false,
      now,
    });
    if (outcome === 'queued') queued += 1;
  }
  return queued;
}

// ---------------------------------------------------------------------------
// 3. A task is up for grabs
// ---------------------------------------------------------------------------

export type UpForGrabsOutcome = 'queued' | 'none' | 'unknown';

/**
 * Offer the household the upcoming tasks nobody has claimed.
 *
 * Scope is `REMINDER_DUE_WINDOW_MS < nextDue <= UP_FOR_GRABS_LOOKAHEAD_MS`:
 * strictly outside the daily reminder's window, so this email and the
 * reminder's own "Up for grabs" section can never name the same task on the
 * same day. See the constants for why the line is drawn there.
 *
 * `unknown` is a real outcome and not the same as `none`. `computePlantsAtRisk`
 * has the bug this avoids: it intersects overdue tasks against the active-plant
 * set, so a short or empty non-throwing `getPlants` silently drops every task
 * and the household is skipped — and the product's own help copy teaches users
 * to read that silence as health. Here, unclaimed tasks with an empty
 * active-plant read is reported as a state we could not settle, and the run
 * summary carries it separately from "nothing was due".
 */
export async function upForGrabsHousehold(
  householdId: string,
  now: Date = new Date()
): Promise<UpForGrabsOutcome> {
  const lookahead = new Date(now.getTime() + UP_FOR_GRABS_LOOKAHEAD_MS).toISOString();
  // The reminder owns everything at or inside its window, overdue included.
  const reminderEdge = new Date(now.getTime() + REMINDER_DUE_WINDOW_MS).toISOString();
  const dueTasks = await taskService.getTasksDueBy(householdId, lookahead);
  const unassigned = dueTasks.filter((t) => !t.assignedTo && t.nextDue > reminderEdge);
  if (unassigned.length === 0) return 'none';

  const plants = await plantService.getPlants(householdId);
  const activePlantIds = new Set(plants.map((p) => p.id));
  if (activePlantIds.size === 0) {
    logger.warn(
      { householdId, unassigned: unassigned.length, msg: 'household_email.active_plants_empty' },
      'household_email.active_plants_empty'
    );
    return 'unknown';
  }
  const claimable = unassigned
    .filter((t) => activePlantIds.has(t.plantId))
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  if (claimable.length === 0) return 'none';

  const householdName = valueOrNull(await readHouseholdName(householdId));
  const members = await householdService.getHouseholdMembers(householdId);
  const item: UpForGrabsItem = {
    householdName,
    totalCount: claimable.length,
    tasks: claimable.slice(0, UP_FOR_GRABS_LIST_LIMIT).map((t) => ({
      plantId: t.plantId,
      plantName: t.plantName,
      type: t.type,
      customType: t.customType,
      nextDue: t.nextDue,
    })),
  };

  let queued = 0;
  for (const member of members) {
    if (!member.email) continue;
    const prefs = await eligible(member.userId, 'up_for_grabs');
    if (!prefs) continue;
    const outcome = await enqueue({
      userId: member.userId,
      email: member.email,
      householdId,
      kind: 'up_for_grabs',
      // Once per ISO week, not once a day. A forward-looking list of unclaimed
      // work barely changes between one morning and the next, so a daily
      // cadence would be the same email again — and this is the one household
      // email whose trigger is a standing state rather than an event, so it is
      // the one that could actually become noise. Weekly is also what makes
      // UP_FOR_GRABS_LOOKAHEAD_MS a complete cover of the gap above the
      // reminder's window.
      dedupeKey: `up_for_grabs#${householdId}#${isoWeekKey(now)}`,
      item,
      maxItems: 1,
      accumulate: false,
      now,
    });
    if (outcome === 'queued') queued += 1;
  }
  return queued > 0 ? 'queued' : 'none';
}

/**
 * ISO-8601 week key, `YYYY-Www`. Same shape and purpose as `digest.isoWeekKey`,
 * written here rather than imported because `digest.ts` belongs to the branch
 * rewriting the shared template layer and this module should not pin its export
 * surface. UTC-based on purpose: unlike the daily keys, a week boundary is not
 * something a recipient perceives, and a per-timezone week would let a member
 * who travels receive two copies for one week.
 */
export function isoWeekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // ISO weeks run Monday–Sunday and are numbered by the Thursday they contain.
  const dayNumber = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Recipient-local calendar date. Same shape as `reminders.localDateKey`;
 *  duplicated rather than imported so this branch does not depend on the
 *  reminder module's export surface. */
export function localDateKey(now: Date, timeZone = 'UTC'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    // A corrupt stored timezone must not abort a household's whole run. UTC
    // is the product's own documented default for an unset zone, so the key
    // stays well-formed; the consequence is at most one extra email on a day
    // boundary, never a missing one.
    return now.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// 4. You are covering while someone is away
// ---------------------------------------------------------------------------

/**
 * Tell the cover, when the window is set, what they have taken on.
 *
 * The task list is read best-effort and passed as `null` when the read fails.
 * `composeCoverageEmail` renders that as "we could not load the list", never as
 * an empty one — a cover told "nothing is scheduled" by a failed query is
 * exactly the failure this product cannot afford.
 */
export async function notifyCoverageAssigned(
  params: {
    householdId: string;
    awayUserId: string;
    coveredBy: string;
    startDate: string;
    endDate: string;
  },
  now: Date = new Date()
): Promise<EnqueueResult | 'ineligible'> {
  const { householdId, awayUserId, coveredBy, startDate, endDate } = params;
  const cover = await readMember(householdId, coveredBy);
  if (cover.status !== 'found' || !cover.value.email) return 'ineligible';
  const prefs = await eligible(coveredBy, 'coverage');
  if (!prefs) return 'ineligible';

  const away = await readMember(householdId, awayUserId);
  const householdName = valueOrNull(await readHouseholdName(householdId));

  // `null` is the NAMED unknown here — "the read did not settle" — and it is
  // set only in the catch. An empty array means the read settled and there is
  // genuinely nothing scheduled, which is a different sentence in the copy.
  let tasks: CoverageItem['tasks'];
  try {
    const assigned = await taskService.getTasks(householdId, { assignedTo: awayUserId });
    tasks = assigned
      .filter((t) => t.nextDue <= endDate)
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
      .slice(0, COVERAGE_LIST_LIMIT)
      .map((t) => ({
        plantId: t.plantId,
        plantName: t.plantName,
        type: t.type,
        customType: t.customType,
        nextDue: t.nextDue,
      }));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, awayUserId },
      'household_email.coverage_tasks_unknown'
    );
    tasks = null;
  }

  return enqueue({
    userId: coveredBy,
    email: cover.value.email,
    householdId,
    kind: 'coverage',
    // Keyed on the window itself, so re-saving the same dates is silent and
    // moving them is a fresh heads-up.
    dedupeKey: `coverage#${householdId}#${awayUserId}#${startDate}#${endDate}`,
    item: {
      awayName: nameOf(away),
      householdName,
      startDate,
      endDate,
      tasks,
    } satisfies CoverageItem,
    maxItems: 1,
    accumulate: false,
    now,
  });
}

// ---------------------------------------------------------------------------
// 5. Someone covered for you
// ---------------------------------------------------------------------------

/**
 * Credit the person who did a task that belonged to someone else.
 *
 * Scope is deliberately narrow: it fires only when a task HAD an assignee and
 * somebody else completed it, and it goes only to that assignee. Two things
 * follow from that, and both are the point.
 *
 * It cannot become a leaderboard. The email names the person who helped and
 * nobody else; it carries no counts, no ordering by volume, no mention of the
 * recipient's own contribution, and no mention of anyone who did less. The
 * brief's market evidence is real — Tody sells FairShare targets and Sweepy
 * sells a family leaderboard — but a floor left uncleaned is an annoyance and
 * a plant left unwatered dies, and `docs/roadmap.md` promises no nagging.
 * Ranking is the mechanism by which a chore app nags.
 *
 * It cannot become noise. Covered completions are rare by construction, and
 * everything a recipient gets in one local day rolls into one email.
 *
 * Broadcasting "Sam watered the Monstera" to the whole household was the
 * obvious alternative and is the thing not built: to four of five recipients it
 * is a stranger's chore, and to the fifth it is the same list re-sent — which
 * is the digest's existing bystander problem with a friendlier subject line.
 */
export async function notifyCoveredCompletion(
  params: {
    householdId: string;
    task: Pick<Task, 'plantId' | 'plantName' | 'type' | 'customType' | 'assignedTo'>;
    completedBy: string;
    notes?: string | null;
  },
  now: Date = new Date()
): Promise<EnqueueResult | 'ineligible'> {
  const { householdId, task, completedBy, notes } = params;
  const assignee = task.assignedTo;
  if (!assignee || assignee === completedBy) return 'ineligible';

  const recipient = await readMember(householdId, assignee);
  if (recipient.status !== 'found' || !recipient.value.email) return 'ineligible';
  const prefs = await eligible(assignee, 'care_credit');
  if (!prefs) return 'ineligible';

  const actor = await readMember(householdId, completedBy);
  const note = notes?.trim();

  return enqueue({
    userId: assignee,
    email: recipient.value.email,
    householdId,
    kind: 'care_credit',
    dedupeKey: `care_credit#${householdId}#${localDateKey(now, prefs.timezone)}`,
    item: {
      plantId: task.plantId,
      plantName: task.plantName,
      type: task.type,
      customType: task.customType,
      actorName: nameOf(actor),
      note: note ? note.slice(0, 240) : null,
    } satisfies CareCreditItemPayload,
    maxItems: CARE_CREDIT_LIST_LIMIT,
    accumulate: true,
    now,
  });
}

// ---------------------------------------------------------------------------
// The hourly pass
// ---------------------------------------------------------------------------

export interface HouseholdEmailRunSummary {
  households: number;
  /** Households offered an up-for-grabs email this pass. */
  offered: number;
  /** Emails SES accepted. Not a delivery claim — see the module comment. */
  sent: number;
  /** Left for a later pass because the recipient is inside their quiet hours. */
  deferred: number;
  /** Dropped for being older than `QUEUE_MAX_AGE_MS`. */
  expired: number;
  /** Households whose up-for-grabs state could not be settled. Kept apart from
   *  `offered: 0` so a broken read cannot be summarised as a calm week. */
  unknown: number;
  failed: number;
  /** Households this run actually reached. Below `households` only when the
   *  run stopped on its deadline. */
  attempted: number;
  /** The run ran out of its share of the invocation before finishing. Alarmed
   *  on — see `services/scheduledFanOut.ts`. */
  truncated: boolean;
}

/**
 * One pass over every household: offer up any unclaimed upcoming tasks,
 * then deliver whatever is queued for each member.
 *
 * Runs on the existing hourly reminder schedule (`handlers/reminders`) rather
 * than a new EventBridge rule, so it needs no Terraform change to start
 * working. Best-effort per household, matching `remindAllHouseholds`: one
 * household's failure must never abort the rest of the run.
 */
export async function runHouseholdEmails(
  now: Date = new Date(),
  options: { deadlineAt?: number } = {}
): Promise<HouseholdEmailRunSummary> {
  const ids = await householdService.listAllHouseholdIds();
  const summary: HouseholdEmailRunSummary = {
    households: ids.length,
    attempted: 0,
    offered: 0,
    sent: 0,
    deferred: 0,
    expired: 0,
    unknown: 0,
    failed: 0,
    truncated: false,
  };
  // `flushed` is read and written only between awaits, so the check-and-add
  // below is still atomic under the bounded concurrency: JavaScript cannot
  // interleave another household between the `has` and the `add`.
  const flushed = new Set<string>();

  const fanOut = await scheduledFanOut.fanOutHouseholds(
    'householdEmails',
    ids,
    async (householdId) => {
      try {
        const outcome = await upForGrabsHousehold(householdId, now);
        if (outcome === 'queued') summary.offered += 1;
        if (outcome === 'unknown') summary.unknown += 1;
      } catch (err) {
        summary.failed += 1;
        logger.warn(
          { err: (err as Error).message, householdId },
          'household_email.up_for_grabs_failed'
        );
      }
      try {
        const members = await householdService.getHouseholdMembers(householdId);
        for (const member of members) {
          // A user in several households has one queue partition; flushing it
          // once per pass is enough and avoids re-querying it per household.
          if (flushed.has(member.userId)) continue;
          flushed.add(member.userId);
          const result = await flushUser(member.userId, now);
          summary.sent += result.sent;
          summary.deferred += result.deferred;
          summary.expired += result.expired;
          summary.failed += result.failed;
        }
      } catch (err) {
        summary.failed += 1;
        logger.warn({ err: (err as Error).message, householdId }, 'household_email.flush_failed');
      }
    },
    { deadlineAt: options.deadlineAt }
  );
  summary.attempted = fanOut.attempted;
  summary.truncated = fanOut.truncated;

  logger.info({ ...summary, msg: 'household_email.run_complete' }, 'household_email.run_complete');
  return summary;
}

/** Queue row key shape, exported so tests can assert the dedupe key without
 *  re-deriving it. */
export const queueRowKey = queueKey;
