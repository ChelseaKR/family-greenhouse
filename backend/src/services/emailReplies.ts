/**
 * Reply-to-act: complete or snooze a reminder's tasks by answering the
 * reminder email (#667, ADR 0031).
 *
 * Invoked once per inbound message by `handlers/emailReplies/handler.ts`,
 * which SES reaches through the `reply-to-act` receipt rule. Everything in the
 * message is untrusted; the checks below run in this order and each one that
 * fails ends the message with NO state change:
 *
 *   1. SES spam AND virus verdicts are both PASS (fail-closed, the forwarder's
 *      rule).
 *   2. Exactly one envelope recipient is a well-formed `care+<token>@<domain>`.
 *   3. The token's digest names a stored row (`emailReplyTokens`). An unknown
 *      token gets no reply: answering addresses we never issued is how a
 *      receiving service becomes a backscatter source.
 *   4. The row's member is still a member of the row's household.
 *   5. The single From mailbox is that member's stored address, exactly.
 *      Anyone else — a housemate the reminder was forwarded to, a spoofer —
 *      gets silence.
 *   6. SES's DMARC verdict for the From domain is PASS, so the From address in
 *      step 5 is authenticated rather than typed. A reply that fails only this
 *      step gets one notice, sent to the member's STORED address (never to
 *      the From), saying nothing was changed.
 *   7. The token has not expired (one notice, same rule).
 *   8. The first line above the quoted text parses as a command
 *      (`email/replyCommand.ts`); anything else gets one help reply per token.
 *   9. Every task number it names is one the email listed.
 *
 * Only then does anything change, and only through the same `taskService`
 * calls the app's own complete/snooze routes make, each pinned to the
 * occurrence the email described. The reply's reach is therefore exactly the
 * recipient's own reach in the app, narrowed to the tasks one email listed:
 * nothing is created, deleted or edited, and no task id is ever read from the
 * message.
 *
 * Every reply goes to the member's stored address with our own subject and
 * body. No inbound header value is copied into an outbound one except a
 * Message-ID that `safeMessageId` has proved is plain printable ASCII.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { HouseholdMember } from '../models/types.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as emailNotifier from './emailNotifier.js';
import * as householdEmails from './householdEmails.js';
import * as replyTokens from './emailReplyTokens.js';
import { recordActivity } from './activity.js';
import { taskLabelFor } from './reminderEmail.js';
import {
  composeExpiredReply,
  composeHelpReply,
  composeOutcomeReply,
  composeUnverifiedReply,
  type HelpReason,
  type ReplyEmail,
  type TaskOutcome,
} from './emailReplyCopy.js';
import { replyAddress, replyDomain, tokenFromRecipient } from './email/replyAddress.js';
import {
  commandLine,
  extractReplyText,
  parseReplyCommand,
  safeMessageId,
  senderAddress,
  type ReplyCommand,
} from './email/replyCommand.js';
import { tasksUrl } from './email/links.js';

export interface SesVerdicts {
  spam?: string;
  virus?: string;
  dmarc?: string;
}

export interface InboundReply {
  /** SES's own id for this receipt; also the S3 object key suffix. */
  sesMessageId: string;
  /** Envelope recipients that matched the receipt rule. */
  recipients: readonly string[];
  /** `mail.commonHeaders.from` as SES parsed it. Untrusted. */
  from: readonly string[] | undefined;
  /** `mail.commonHeaders.messageId`. Untrusted. */
  messageId: string | undefined;
  verdicts: SesVerdicts;
  /** Fetches the raw message. Called only once every check above the body
   *  has passed, so a message that fails early is never downloaded. */
  loadBody: () => Promise<Buffer>;
}

export type ReplyDisposition =
  | 'not_configured'
  | 'dropped_scan'
  | 'dropped_no_token'
  | 'duplicate'
  | 'dropped_unknown_token'
  | 'dropped_not_member'
  | 'dropped_sender_mismatch'
  | 'dropped_unauthenticated'
  | 'expired'
  | 'help'
  | 'applied';

export interface ReplyResult {
  disposition: ReplyDisposition;
  /** Present for `applied`. */
  outcomes?: TaskOutcome[];
  /** Whether a reply email was accepted by SES for this message. */
  replied: boolean;
}

function passesScan(verdicts: SesVerdicts): boolean {
  return verdicts.spam === 'PASS' && verdicts.virus === 'PASS';
}

function supportAddress(): string | null {
  return process.env.SES_REPLY_TO?.trim() || null;
}

function memberName(member: HouseholdMember): string {
  // The app's own completion route resolves the name the same way
  // (handlers/tasks/handler.ts resolveCompleterName): the roster name, else
  // the address's local part. Both come from a row that WAS read.
  return member.name?.trim() || member.email.split('@')[0];
}

interface Context {
  token: string;
  domain: string;
  record: replyTokens.ReplyTokenRecord;
  member: HouseholdMember;
  inReplyTo: string | null;
  now: Date;
}

/**
 * Send one reply to the member's stored address, charged to the token's
 * budget. A send that throws gives its budget slot back before rethrowing,
 * so the retry that follows can still send it.
 */
async function sendReply(
  ctx: Context,
  kind: replyTokens.ReplySendKind,
  email: ReplyEmail,
  options: { replyToToken: boolean }
): Promise<boolean> {
  const slot = await replyTokens.claimReplySend(ctx.record.digest, kind, ctx.now);
  if (slot === 'exhausted') {
    logger.info(
      { householdId: ctx.record.householdId, kind, msg: 'email_reply.reply_budget_exhausted' },
      'email_reply.reply_budget_exhausted'
    );
    return false;
  }
  try {
    const result = await emailNotifier.sendEmailAccepted({
      to: ctx.member.email,
      subject: email.subject,
      text: email.text,
      ...(options.replyToToken ? { replyTo: replyAddress(ctx.token, ctx.domain) } : {}),
      ...(ctx.inReplyTo
        ? { headers: { 'In-Reply-To': ctx.inReplyTo, References: ctx.inReplyTo } }
        : {}),
    });
    if (!result.accepted) {
      logger.warn(
        { householdId: ctx.record.householdId, kind, reason: result.reason },
        'email_reply.reply_not_sent'
      );
    }
    return result.accepted;
  } catch (err) {
    await replyTokens.releaseReplySend(ctx.record.digest, kind).catch((releaseErr: unknown) => {
      logger.warn(
        { err: (releaseErr as Error).message, householdId: ctx.record.householdId, kind },
        'email_reply.reply_slot_release_failed'
      );
    });
    throw err;
  }
}

async function sendHelp(ctx: Context, reason: HelpReason): Promise<ReplyResult> {
  const replied = await sendReply(
    ctx,
    'help',
    composeHelpReply({
      locale: ctx.record.locale,
      reason,
      taskCount: ctx.record.tasks.length,
      supportAddress: supportAddress(),
    }),
    { replyToToken: true }
  );
  logger.info(
    { householdId: ctx.record.householdId, reason, replied, msg: 'email_reply.help' },
    'email_reply.help'
  );
  return { disposition: 'help', replied };
}

/** Which of the email's tasks a command names, or why it names none. */
function resolveTargets(
  command: Exclude<ReplyCommand, { kind: 'unrecognized' }>,
  taskCount: number
): number[] | HelpReason {
  if (command.tasks === null) return taskCount === 1 ? [1] : 'which_task';
  if (command.tasks.some((n) => n > taskCount)) return 'no_such_task';
  return command.tasks;
}

async function applyOne(
  ctx: Context,
  command: Exclude<ReplyCommand, { kind: 'unrecognized' }>,
  number: number
): Promise<TaskOutcome> {
  const { record, member } = ctx;
  const target = record.tasks[number - 1];
  const describe = (task: {
    plantName: string;
    type: Parameters<typeof taskLabelFor>[0];
    customType?: string | null;
  }) => ({
    plantName: task.plantName?.trim() || null,
    taskLabel: taskLabelFor(task.type, task.customType ?? null, record.locale),
  });

  if (command.kind === 'complete') {
    const outcome = await taskService.completeTaskWithOutcome(
      record.householdId,
      target.taskId,
      member.userId,
      memberName(member),
      undefined,
      target.expectedNextDue
    );
    if (!outcome) return { kind: 'gone', number };
    if (!outcome.changed) {
      return { kind: 'settled', number, ...describe(outcome.task), nextDue: outcome.task.nextDue };
    }
    // The same courtesy the app's completion route extends: the person whose
    // task this was hears that it got done. Best-effort, as there.
    try {
      await householdEmails.notifyCoveredCompletion({
        householdId: record.householdId,
        task: outcome.task,
        completedBy: member.userId,
        notes: null,
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, householdId: record.householdId },
        'email_reply.care_credit_failed'
      );
    }
    return { kind: 'completed', number, ...describe(outcome.task), nextDue: outcome.task.nextDue };
  }

  const outcome = await taskService.snoozeTaskWithOutcome(
    record.householdId,
    target.taskId,
    command.days,
    target.expectedNextDue
  );
  if (!outcome) return { kind: 'gone', number };
  if (!outcome.changed) {
    return { kind: 'settled', number, ...describe(outcome.task), nextDue: outcome.task.nextDue };
  }
  // The app's snooze route writes this row too; the feed reads the same.
  await recordActivity({
    type: 'task.snoozed',
    householdId: record.householdId,
    actorId: member.userId,
    actorName: memberName(member),
    payload: {
      taskId: target.taskId,
      plantId: outcome.task.plantId,
      plantName: outcome.task.plantName,
      taskType: outcome.task.customType || outcome.task.type,
      days: command.days,
      reason: null,
      note: null,
    },
  });
  return {
    kind: 'snoozed',
    number,
    ...describe(outcome.task),
    days: command.days,
    nextDue: outcome.task.nextDue,
  };
}

async function processClaimed(
  reply: InboundReply,
  token: string,
  domain: string,
  now: Date
): Promise<ReplyResult> {
  const read = await replyTokens.readReplyToken(token);
  if (read.status !== 'found') {
    logger.info(
      { status: read.status, msg: 'email_reply.unknown_token' },
      'email_reply.unknown_token'
    );
    return { disposition: 'dropped_unknown_token', replied: false };
  }
  const { record } = read;

  const member = await householdService.getMemberByUserId(record.householdId, record.userId);
  if (!member || !member.email) {
    logger.info(
      { householdId: record.householdId, msg: 'email_reply.not_a_member' },
      'email_reply.not_a_member'
    );
    return { disposition: 'dropped_not_member', replied: false };
  }

  const sender = senderAddress(reply.from);
  if (!sender || sender !== member.email.trim().toLowerCase()) {
    // Addresses stay out of the logs, as everywhere else in this codebase.
    logger.info(
      { householdId: record.householdId, parsed: sender !== null },
      'email_reply.sender_mismatch'
    );
    return { disposition: 'dropped_sender_mismatch', replied: false };
  }

  const ctx: Context = {
    token,
    domain,
    record,
    member,
    inReplyTo: safeMessageId(reply.messageId),
    now,
  };

  if (reply.verdicts.dmarc !== 'PASS') {
    logger.info(
      { householdId: record.householdId, dmarc: reply.verdicts.dmarc ?? 'MISSING' },
      'email_reply.unauthenticated'
    );
    const replied = await sendReply(
      ctx,
      'unverified',
      composeUnverifiedReply({ locale: record.locale, appUrl: tasksUrl() }),
      { replyToToken: false }
    );
    return { disposition: 'dropped_unauthenticated', replied };
  }

  if (now.getTime() >= record.expiresAt * 1000) {
    const replied = await sendReply(
      ctx,
      'expired',
      composeExpiredReply({
        locale: record.locale,
        validDays: Math.round(replyTokens.REPLY_TOKEN_TTL_SECONDS / 86_400),
        appUrl: tasksUrl(),
      }),
      { replyToToken: false }
    );
    logger.info({ householdId: record.householdId, replied }, 'email_reply.expired');
    return { disposition: 'expired', replied };
  }

  const command = parseReplyCommand(commandLine(extractReplyText(await reply.loadBody())));
  if (command.kind === 'unrecognized') return sendHelp(ctx, 'unrecognized');

  const targets = resolveTargets(command, record.tasks.length);
  if (!Array.isArray(targets)) return sendHelp(ctx, targets);

  const outcomes: TaskOutcome[] = [];
  for (const number of targets) {
    outcomes.push(await applyOne(ctx, command, number));
  }

  const replied = await sendReply(
    ctx,
    'outcome',
    composeOutcomeReply({
      locale: record.locale,
      timeZone: record.timeZone,
      outcomes,
      appUrl: tasksUrl(),
      supportAddress: supportAddress(),
    }),
    { replyToToken: true }
  );
  logger.info(
    {
      householdId: record.householdId,
      command: command.kind,
      completed: outcomes.filter((o) => o.kind === 'completed').length,
      snoozed: outcomes.filter((o) => o.kind === 'snoozed').length,
      settled: outcomes.filter((o) => o.kind === 'settled').length,
      gone: outcomes.filter((o) => o.kind === 'gone').length,
      replied,
      msg: 'email_reply.applied',
    },
    'email_reply.applied'
  );
  return { disposition: 'applied', outcomes, replied };
}

/**
 * Handle one inbound reply. Returns how it was disposed of; THROWS on any
 * infrastructure failure (a DynamoDB read, an SES send) so the async invoke
 * is retried and, past the retries, dead-lettered — a reply we could not
 * read is never reported as a reply we chose to ignore.
 *
 * A retry after a partial failure re-runs every step. Actions are pinned to
 * their occurrence, so nothing is applied twice; the confirmation then
 * reports what the first attempt already did as "already taken care of",
 * which is true, if less satisfying.
 */
export async function handleInboundReply(
  reply: InboundReply,
  now: Date = new Date()
): Promise<ReplyResult> {
  const domain = replyDomain();
  if (!domain) {
    logger.warn({ msg: 'email_reply.not_configured' }, 'email_reply.not_configured');
    return { disposition: 'not_configured', replied: false };
  }

  if (!passesScan(reply.verdicts)) {
    logger.info(
      { spam: reply.verdicts.spam ?? 'MISSING', virus: reply.verdicts.virus ?? 'MISSING' },
      'email_reply.scan_not_passed'
    );
    return { disposition: 'dropped_scan', replied: false };
  }

  const tokens = new Set<string>();
  for (const recipient of reply.recipients) {
    const token = tokenFromRecipient(recipient, domain);
    if (token) tokens.add(token);
  }
  if (tokens.size !== 1) {
    logger.info({ tokens: tokens.size }, 'email_reply.no_single_token');
    return { disposition: 'dropped_no_token', replied: false };
  }
  const [token] = tokens;

  const reservationId = randomUUID();
  const claim = await replyTokens.claimInboundMessage(reply.sesMessageId, reservationId, now);
  if (claim.kind === 'duplicate') {
    logger.info({ msg: 'email_reply.duplicate' }, 'email_reply.duplicate');
    return { disposition: 'duplicate', replied: false };
  }

  let result: ReplyResult;
  try {
    result = await processClaimed(reply, token, domain, now);
  } catch (err) {
    await replyTokens
      .releaseInboundMessage(reply.sesMessageId, reservationId)
      .catch((releaseErr: unknown) => {
        logger.error(
          { err: (releaseErr as Error).message },
          'email_reply.message_claim_release_failed'
        );
      });
    throw err;
  }

  await replyTokens
    .finalizeInboundMessage(reply.sesMessageId, reservationId, result.disposition, now)
    .catch((err: unknown) => {
      // The work is done; only the bookkeeping failed. The lease expires on
      // its own, and a redelivery re-runs steps that are all idempotent.
      logger.warn({ err: (err as Error).message }, 'email_reply.message_claim_finalize_failed');
    });
  return result;
}
