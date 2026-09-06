/**
 * "Ask family to do it" (ADR 0024) — the I/O half.
 *
 * A member who cannot do a task asks their household to pick it up, with an
 * optional short note ("I'm travelling until Sunday"). Until now the only
 * exits were `unclaim` — which releases the occurrence and tells nobody — or
 * saying nothing at all.
 *
 * ## One state, two doors
 *
 * The ask does NOT invent a state. It drives the occurrence into the same
 * ESCALATED slot auto-handoff uses (ADR 0018, precedence 2): `assignedTo`
 * cleared and `escalatedForDue` pinned to this `nextDue`, so nothing
 * re-assigns it until it is claimed or completed, the hourly scan will not
 * nag about a lapse a person has already raised, and a completion re-arms
 * both doors by advancing `nextDue`. The `helpAsked*` fields record WHO asked
 * and WHY; they are not a second precedence level.
 *
 * ## Free on every tier
 *
 * Auto-handoff is paid because it is automation — the app nags so nobody has
 * to. This is a person talking to their own household, the same category as
 * `claim`/`unclaim`, so there is no plan gate and `models/plans.ts` is not
 * consulted. Charging a member to ask their family for help would be hostile.
 *
 * ## Volume guardrails
 *
 *   - ONE ask per task per member per 24 hours, enforced in DynamoDB by a
 *     conditional Put on a marker row with a TTL (the technique
 *     `upgradeRequests.ts` uses) — never an in-memory limiter, which would
 *     bind only to one warm Lambda container;
 *   - at most once per OCCURRENCE, enforced by a conditional write on
 *     `helpAskedForDue`, so two taps cannot both notify;
 *   - one message per recipient, never the asker, never anyone away, never
 *     anyone inside Do-Not-Disturb (the same recipient filter auto-handoff
 *     uses — see `askFamilyRule.askRecipients`).
 *
 * ## Nobody could be reached is a RESULT, not a failure and not a success
 *
 * `recipients` is who was told and `skipped` says who was not and why, so a
 * one-person household, or one where everyone is away or asleep, gets an
 * honest "nobody could be reached right now" instead of a cheerful checkmark.
 * The reads that decide this — the roster, the vacation windows and every
 * member's notification preferences — happen BEFORE anything is written, and
 * a failure in any of them aborts the whole ask. An unread roster is not an
 * empty household (ADR 0010).
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { HouseholdMember, Task } from '../models/types.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as notifier from './notifier.js';
import { recordActivity } from './activity.js';
import { isAwayAt, isExplicitAssignment } from './assignmentResolver.js';
import { householdLocaleFrom, resolveEmailLocale } from './email/locale.js';
import {
  ASK_HELP_WINDOW_MS,
  askRecipients,
  composeAskNotification,
  normalizeHelpNote,
} from './askFamilyRule.js';

export {
  ASK_HELP_NOTE_MAX_LENGTH,
  ASK_HELP_WINDOW_MS,
  composeAskNotification,
  isHelpRequestOpen,
  normalizeHelpNote,
} from './askFamilyRule.js';

/** Slack past the window before DynamoDB TTL sweeps the marker, so an ask
 *  landing right at the boundary still sees the row it should. */
const TTL_BUFFER_MS = 24 * 60 * 60 * 1000;

/**
 * Error classes handlers map to status codes. Call sites check `err.name`
 * rather than `instanceof` so a test automock of this module still maps —
 * the repo's PlanLimitError / UpgradeRequestRateLimitedError convention.
 */

/** No such task in this household. → 404 */
export class TaskNotFoundError extends Error {
  constructor() {
    super('Task not found');
    this.name = 'TaskNotFoundError';
  }
}

/** Somebody else explicitly holds this task; you cannot give away their
 *  work. Inherited assignments (space default, Move Day, rotation) are
 *  suggestions and DO NOT trigger this — the same line `claimTask` draws. → 403 */
export class TaskHeldByAnotherMemberError extends Error {
  constructor() {
    super('This task is assigned to someone else — only they can ask the household to take it.');
    this.name = 'TaskHeldByAnotherMemberError';
  }
}

/** This occurrence is already up for grabs because someone asked. → 409 */
export class HelpAlreadyRequestedError extends Error {
  constructor() {
    super('Someone has already asked the household about this one.');
    this.name = 'HelpAlreadyRequestedError';
  }
}

/** The row moved under us between the read and the write — completed,
 *  rescheduled, or claimed. The client should reload rather than retry
 *  blindly against an occurrence that no longer exists. → 409 */
export class TaskChangedError extends Error {
  constructor() {
    super('This task changed while you were asking. Reload and try again.');
    this.name = 'TaskChangedError';
  }
}

/** This member already asked about this task inside the 24-hour window.
 *  `nextAllowedAt` is read from the stored marker; null ONLY when that read
 *  could not be made, never a guessed date. → 429 */
export class AskHelpRateLimitedError extends Error {
  readonly nextAllowedAt: string | null;
  constructor(nextAllowedAt: string | null) {
    super('You already asked about this task today. You can ask again tomorrow.');
    this.name = 'AskHelpRateLimitedError';
    this.nextAllowedAt = nextAllowedAt;
  }
}

export interface AskFamilyInput {
  householdId: string;
  taskId: string;
  asker: { userId: string; email: string };
  /** The asker's optional note; normalised (and possibly nulled) on the way in. */
  note?: string | null;
  /**
   * The `nextDue` the client believed it was asking about. When supplied and
   * stale the ask is refused rather than redirected onto whatever occurrence
   * is current — the same retry guard `snoozeTaskSchema.expectedNextDue` uses.
   */
  expectedNextDue?: string | null;
  now?: Date;
}

/** A household member, by name only — never their email (Privacy Policy). */
export interface AskFamilyMember {
  userId: string;
  name: string;
}

/** Why a member was deliberately left out. Surfaced so "we told two of your
 *  four housemates" can be explained rather than silently rounded. */
export type AskSkipReason = 'away' | 'dnd';

export interface AskFamilySkipped extends AskFamilyMember {
  reason: AskSkipReason;
}

export interface AskFamilyResult {
  /** The task as it now stands: unassigned, up for grabs, ask recorded. */
  task: Task;
  note: string | null;
  askedAt: string;
  /** When this member may ask about this task again. */
  nextAllowedAt: string;
  /** Who the ask went out to. EMPTY is a real answer — everyone is away, in
   *  Do-Not-Disturb, or there is nobody else in the household. */
  recipients: AskFamilyMember[];
  /** Who was deliberately not told, and why. */
  skipped: AskFamilySkipped[];
  /** How many recipients had at least one channel ACTUALLY deliver. 0 against
   *  a non-empty `recipients` means we tried and nothing left the building;
   *  the caller must not render that as a delivered ask. */
  delivered: number;
}

function markerKey(householdId: string, taskId: string, userId: string) {
  return { PK: `HOUSEHOLD#${householdId}`, SK: `TASK_HELP_ASK#${taskId}#${userId}` };
}

async function readNextAllowedAt(
  householdId: string,
  taskId: string,
  userId: string
): Promise<string | null> {
  const existing = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: markerKey(householdId, taskId, userId) })
  );
  const item = existing.Item as Record<string, unknown> | undefined;
  const epoch = item?.askedAtEpoch;
  if (typeof epoch !== 'number') return null;
  return new Date(epoch * 1000 + ASK_HELP_WINDOW_MS).toISOString();
}

/**
 * Claim this member's daily slot for this task. The conditional Put is the
 * authority; the read after a refusal exists only to report an honest
 * `nextAllowedAt`.
 */
async function claimDailySlot(
  householdId: string,
  taskId: string,
  userId: string,
  now: Date
): Promise<number> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const cutoffEpoch = Math.floor((now.getTime() - ASK_HELP_WINDOW_MS) / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...markerKey(householdId, taskId, userId),
          entityType: 'TaskHelpAsk',
          householdId,
          taskId,
          userId,
          askedAt: now.toISOString(),
          askedAtEpoch: nowEpoch,
          ttl: Math.floor((now.getTime() + ASK_HELP_WINDOW_MS + TTL_BUFFER_MS) / 1000),
        },
        // Absent, or older than the window: a fresh ask. Anything younger is
        // refused atomically, so two concurrent taps can never both send.
        ConditionExpression: 'attribute_not_exists(PK) OR askedAtEpoch < :cutoff',
        ExpressionAttributeValues: { ':cutoff': cutoffEpoch },
      })
    );
    return nowEpoch;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const nextAllowedAt = await readNextAllowedAt(householdId, taskId, userId).catch(
        (readErr) => {
          logger.warn(
            { err: (readErr as Error).message, householdId, taskId, userId },
            'ask_family.next_allowed_read_failed'
          );
          return null;
        }
      );
      throw new AskHelpRateLimitedError(nextAllowedAt);
    }
    throw err;
  }
}

/**
 * Give the slot back when the ask it was claimed for did not happen (the task
 * write lost a race). Conditioned on the exact epoch we wrote so a concurrent
 * ask's fresh marker is never deleted. Best-effort: the worst case of a failed
 * release is one member waiting out a 24-hour window for an ask that did not
 * send, which is logged rather than escalated into a 500 on a request whose
 * real answer is the conflict below.
 */
async function releaseDailySlot(
  householdId: string,
  taskId: string,
  userId: string,
  epoch: number
): Promise<void> {
  try {
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: markerKey(householdId, taskId, userId),
        ConditionExpression: 'askedAtEpoch = :epoch',
        ExpressionAttributeValues: { ':epoch': epoch },
      })
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, taskId, userId },
      'ask_family.slot_release_failed'
    );
  }
}

/**
 * Atomically put ONE occurrence up for grabs on behalf of a person.
 *
 * The condition pins three things at once, so no interleaving can produce a
 * surprise: the occurrence (`nextDue` unchanged since we read it), once-only
 * (`helpAskedForDue` is not already this occurrence), and the holder
 * (`assignedTo` exactly what we read, so nobody's claim is stripped by a
 * write that raced it). Returns null when the condition failed; the caller
 * re-reads to say WHICH of the three moved.
 */
async function markHelpRequested(
  task: Task,
  asker: { userId: string; name: string },
  note: string | null,
  now: Date
): Promise<Task | null> {
  const names: Record<string, string> = {
    '#assignedTo': 'assignedTo',
    '#assignedToName': 'assignedToName',
    '#assignmentSource': 'assignmentSource',
    '#nextDue': 'nextDue',
    '#escalatedAt': 'escalatedAt',
    '#escalatedForDue': 'escalatedForDue',
    '#escalatedFrom': 'escalatedFrom',
    '#helpAskedAt': 'helpAskedAt',
    '#helpAskedBy': 'helpAskedBy',
    '#helpAskedByName': 'helpAskedByName',
    '#helpAskedNote': 'helpAskedNote',
    '#helpAskedForDue': 'helpAskedForDue',
  };
  const values: Record<string, unknown> = {
    ':now': now.toISOString(),
    ':due': task.nextDue,
    // Whoever the occurrence is being taken from. When it was already up for
    // grabs (auto-handoff got there first) the earlier holder is preserved
    // rather than overwritten with null.
    ':from': task.assignedTo ?? task.escalatedFrom ?? null,
    ':asker': asker.userId,
    ':askerName': asker.name,
    ':note': note,
    ':null': null,
  };
  // Pin the holder we read. An unheld task must still be unheld; a held one
  // must still be held by the same person (the asker, or an inherited
  // suggestion anyone may take over).
  let holderClause: string;
  if (task.assignedTo === null) {
    holderClause = '(attribute_not_exists(#assignedTo) OR #assignedTo = :null)';
  } else {
    holderClause = '#assignedTo = :holder';
    values[':holder'] = task.assignedTo;
  }

  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${task.householdId}`, SK: `TASK#${task.id}` },
        UpdateExpression:
          'SET #helpAskedAt = :now, #helpAskedBy = :asker, #helpAskedByName = :askerName, ' +
          '#helpAskedNote = :note, #helpAskedForDue = :due, ' +
          '#escalatedAt = :now, #escalatedForDue = :due, #escalatedFrom = :from, ' +
          '#assignedTo = :null, #assignedToName = :null, #assignmentSource = :null ' +
          'REMOVE GSI2PK, GSI2SK',
        ConditionExpression:
          'attribute_exists(PK) AND #nextDue = :due AND ' +
          '(attribute_not_exists(#helpAskedForDue) OR #helpAskedForDue <> :due) AND ' +
          holderClause,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      })
    );
    return result.Attributes ? taskService.itemToTask(result.Attributes) : null;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

/** Turn a lost race into the specific refusal the client can act on. */
async function explainRefusal(householdId: string, taskId: string): Promise<Error> {
  const current = await taskService.getTask(householdId, taskId);
  if (!current) return new TaskNotFoundError();
  if (current.helpAskedForDue === current.nextDue) return new HelpAlreadyRequestedError();
  return new TaskChangedError();
}

/**
 * Ask the household to pick up one task occurrence.
 *
 * Order matters and is deliberate: every read that decides who hears about
 * this happens first (so a failed read aborts before anything is written),
 * then the member's daily slot, then the authoritative task write, and only
 * then the fan-out. A refusal at the task write hands the slot back — a
 * member who was beaten to it by a housemate should not also lose their turn.
 */
export async function askFamilyForHelp(input: AskFamilyInput): Promise<AskFamilyResult> {
  const now = input.now ?? new Date();
  const { householdId, taskId } = input;
  const note = normalizeHelpNote(input.note);

  const task = await taskService.getTask(householdId, taskId);
  if (!task) throw new TaskNotFoundError();
  if (input.expectedNextDue && input.expectedNextDue !== task.nextDue) {
    throw new TaskChangedError();
  }
  // Somebody else's explicit claim is theirs to release. Inherited
  // assignments stay askable by anyone, exactly as they stay claimable.
  if (isExplicitAssignment(task) && task.assignedTo !== input.asker.userId) {
    throw new TaskHeldByAnotherMemberError();
  }
  if (task.helpAskedForDue === task.nextDue) throw new HelpAlreadyRequestedError();

  // --- reads that decide who hears about this -----------------------------
  // Deliberately un-caught. A roster or preference read that fails must not
  // become "nobody to notify" and then be reported as a delivered ask.
  const [members, vacations] = await Promise.all([
    householdService.getHouseholdMembers(householdId),
    taskService.listVacationWindows(householdId, now),
  ]);
  const ordered: HouseholdMember[] = [...members].sort((a, b) =>
    a.joinedAt.localeCompare(b.joinedAt)
  );
  const prefsByUser = new Map<string, notificationPrefs.NotificationPreferences>();
  for (const member of ordered) {
    prefsByUser.set(member.userId, await notificationPrefs.getPreferences(member.userId));
  }
  // Free: every member's stored choice is already in hand, so the household's
  // prevailing language costs no extra read (services/email/locale.ts).
  const householdLocale = householdLocaleFrom(
    ordered.map((member) => prefsByUser.get(member.userId)?.emailLocale)
  );

  const askerName =
    members.find((m) => m.userId === input.asker.userId)?.name?.trim() || 'A household member';

  const isAway = (userId: string) => isAwayAt(vacations, userId, now);
  const isInDnd = (userId: string) => {
    const prefs = prefsByUser.get(userId);
    return prefs ? notificationPrefs.isInDndWindow(prefs, now) : false;
  };
  const recipients = askRecipients(members, input.asker.userId, isAway, isInDnd);
  const recipientIds = new Set(recipients.map((r) => r.userId));
  const skipped: AskFamilySkipped[] = members
    .filter((m) => m.userId !== input.asker.userId && !recipientIds.has(m.userId))
    .map((m) => ({
      userId: m.userId,
      name: m.name,
      reason: isAway(m.userId) ? ('away' as const) : ('dnd' as const),
    }));

  // --- writes -------------------------------------------------------------
  const slotEpoch = await claimDailySlot(householdId, taskId, input.asker.userId, now);
  const updated = await markHelpRequested(
    task,
    { userId: input.asker.userId, name: askerName },
    note,
    now
  ).catch(async (err) => {
    await releaseDailySlot(householdId, taskId, input.asker.userId, slotEpoch);
    throw err;
  });
  if (!updated) {
    await releaseDailySlot(householdId, taskId, input.asker.userId, slotEpoch);
    throw await explainRefusal(householdId, taskId);
  }

  // --- fan-out ------------------------------------------------------------
  // Best-effort and reported truthfully rather than thrown: the ask is
  // already recorded, so a flaky channel must not turn it into a client error
  // that invites a retry the rate limit would refuse.
  const taskType = updated.customType || updated.type;
  let delivered = 0;
  await Promise.all(
    recipients.map(async (member) => {
      const prefs = prefsByUser.get(member.userId);
      const { locale } = resolveEmailLocale(prefs?.emailLocale, householdLocale);
      const message = composeAskNotification(locale, {
        askerName,
        plantName: updated.plantName,
        taskType,
        note,
      });
      try {
        const result = await notifier.sendToUser(
          { userId: member.userId, email: member.email },
          {
            title: message.title,
            body: message.body,
            shortBody: message.shortBody,
            tag: `ask-family:${householdId}:${taskId}:${updated.nextDue}`,
            url: frontendUrl('/tasks'),
          },
          { now, preferences: prefs }
        );
        if (result.delivered) delivered += 1;
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, householdId, taskId, userId: member.userId },
          'ask_family.send_failed'
        );
      }
    })
  );

  await recordActivity({
    type: 'task.help_requested',
    householdId,
    actorId: input.asker.userId,
    actorName: askerName,
    payload: {
      taskId,
      plantId: updated.plantId,
      plantName: updated.plantName,
      taskType,
      note,
      notified: recipients.length,
    },
  });

  logger.info(
    {
      householdId,
      taskId,
      askedBy: input.asker.userId,
      recipients: recipients.length,
      skipped: skipped.length,
      delivered,
      hasNote: note !== null,
    },
    'ask_family.sent'
  );

  return {
    task: updated,
    note,
    askedAt: now.toISOString(),
    nextAllowedAt: new Date(now.getTime() + ASK_HELP_WINDOW_MS).toISOString(),
    recipients: recipients.map((r) => ({ userId: r.userId, name: r.name })),
    skipped,
    delivered,
  };
}

function frontendUrl(path: string): string {
  const base = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';
  return new URL(path, base).toString();
}
