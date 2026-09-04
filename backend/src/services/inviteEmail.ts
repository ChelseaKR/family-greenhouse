/**
 * Emailing a household invite.
 *
 * `householdService.createInvite` has minted a 128-bit code with a 7-day TTL
 * since May 2026 and the product has never been able to send one: invites are
 * copy-and-paste links, so joining a household requires the inviter to already
 * have a channel to the invitee. `docs/roadmap.md`'s north star is "active
 * members per household ≥1.5", `docs/analytics.md` flags
 * `invite_sent → invite_accepted` as the unmeasurable core loop, and the loop
 * had no email step at all. This is that step.
 *
 * ## Why this is the one household email that does not use the queue
 *
 * The other four (`services/householdEmails.ts`) are queued: their recipients
 * are members with preferences and quiet hours. An invitee is not a user. They
 * have no preferences row, no DND window, no account, and no relationship with
 * this product except the person who typed their address. So this path sends
 * synchronously and reports honestly what happened, and the caller keeps the
 * copyable link either way.
 *
 * ## Not becoming a way to mail strangers
 *
 * An endpoint that emails an arbitrary address on request is a spam cannon
 * unless it is bounded, so it is bounded four ways:
 *
 *   1. **Admin only**, the same gate `POST /households/:id/invites` already has.
 *   2. **A per-household daily cap** (`DAILY_INVITE_EMAIL_CAP`), enforced by a
 *      conditional counter so two concurrent requests cannot both slip under it.
 *   3. **One email per address per household per day**, so the endpoint cannot
 *      be used to repeatedly mail one person who is ignoring it.
 *   4. **Copy that reads as a personal invitation.** It names the person who
 *      sent it and the household they are inviting you to, in the first line
 *      and in the subject; it says plainly what accepting means; and it tells
 *      the recipient that ignoring it ends the matter. An invite that cannot
 *      name its sender or the household is NOT SENT — see `sendInviteEmail`.
 *      Anonymous "you have been invited to a workspace" mail is the shape this
 *      deliberately refuses.
 *
 * Deliberately absent: any free-text field the inviter could fill. Attacker-
 * controlled prose in a message we send on their behalf is how an invite
 * feature becomes an open relay.
 */
import { PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import * as emailNotifier from './emailNotifier.js';
import { composeInviteEmail, normalizeEmailLocale, type EmailLocale } from './emailCopy.js';

/** Invite emails one household may send per UTC day. Sized for the real job —
 *  a household's plan caps members at 50, and inviting even six people in a day
 *  is unusual — while leaving no useful headroom for abuse. */
export const DAILY_INVITE_EMAIL_CAP = 10;
/** Counter row outlives its day; DynamoDB TTL sweeps it. */
const COUNTER_TTL_SECONDS = 48 * 60 * 60;
/** How long one recipient address is off-limits for a repeat invite. */
const RECIPIENT_COOLDOWN_SECONDS = 24 * 60 * 60;

export type InviteEmailStatus =
  /** SES accepted the message. Acceptance is not delivery — there is no bounce
   *  destination wired yet — so the field is named for what we actually know. */
  | 'accepted'
  /** Email delivery is not configured in this environment (the dry-run path).
   *  The caller still has a working invite link to show. */
  | 'unavailable'
  /** We could not name the inviter or the household, so there is no honest
   *  invitation to write. */
  | 'identity_unavailable'
  /** This address already got an invite to this household today. */
  | 'recipient_cooldown'
  /** The household has used its daily allowance. */
  | 'rate_limited';

export interface SendInviteEmailInput {
  householdId: string;
  /** The address to invite. Normalized for the cooldown key only; the message
   *  goes to exactly what was typed. */
  to: string;
  /** Display name of the member sending the invite. Required — an empty or
   *  unresolved name produces `identity_unavailable`, never an anonymous
   *  invitation. */
  inviterName: string | null;
  householdName: string | null;
  joinUrl: string;
  expiresAt: string;
  /** The inviter's UI language. The invitee has no stored preference to read —
   *  they have no account — so the sender's locale is the best available
   *  signal, and it is usually right: you invite people you talk to. */
  locale?: unknown;
}

function recipientKeyFor(email: string): string {
  // Hashed so a raw address is not a sort key, and lower-cased so casing
  // variations cannot be used to walk around the cooldown.
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Consume one of the household's daily invite emails.
 *
 * The conditional `ADD` is the whole point: a check-then-write would let two
 * concurrent requests both read 9 and both write 10.
 */
async function consumeDailyAllowance(householdId: string, now: Date): Promise<boolean> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: `INVITE_EMAIL_COUNT#${utcDay(now)}` },
        UpdateExpression: 'ADD #count :one SET entityType = :entityType, #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :cap',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':cap': DAILY_INVITE_EMAIL_CAP,
          ':entityType': 'InviteEmailCounter',
          ':ttl': Math.floor(now.getTime() / 1000) + COUNTER_TTL_SECONDS,
        },
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Give the allowance back when the send did not happen. */
async function refundDailyAllowance(householdId: string, now: Date): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: `INVITE_EMAIL_COUNT#${utcDay(now)}` },
      UpdateExpression: 'ADD #count :minusOne',
      ConditionExpression: '#count > :zero',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
    })
  );
}

/** Claim this address for the cooldown window. False when it is already held. */
async function claimRecipient(householdId: string, to: string, now: Date): Promise<boolean> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `INVITE_EMAIL_TO#${recipientKeyFor(to)}`,
          entityType: 'InviteEmailRecipientMarker',
          sentAt: now.toISOString(),
          ttl: Math.floor(now.getTime() / 1000) + RECIPIENT_COOLDOWN_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function releaseRecipient(householdId: string, to: string): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: `INVITE_EMAIL_TO#${recipientKeyFor(to)}` },
    })
  );
}

/**
 * Email one invite.
 *
 * Every outcome is named. Nothing here reports a send that did not happen: a
 * dry run returns `unavailable` (and the caller shows the copyable link),
 * a failed identity read returns `identity_unavailable` rather than mailing a
 * stranger an anonymous invitation, and both refund whatever they consumed so
 * a later attempt is not penalised for a failure that was ours.
 */
export async function sendInviteEmail(
  input: SendInviteEmailInput,
  now: Date = new Date()
): Promise<InviteEmailStatus> {
  const inviterName = input.inviterName?.trim();
  const householdName = input.householdName?.trim();
  if (!inviterName || !householdName) {
    logger.warn(
      {
        householdId: input.householdId,
        hasInviter: Boolean(inviterName),
        hasHousehold: Boolean(householdName),
      },
      'invite_email.identity_unavailable'
    );
    return 'identity_unavailable';
  }

  if (!(await consumeDailyAllowance(input.householdId, now))) {
    logger.info({ householdId: input.householdId }, 'invite_email.rate_limited');
    return 'rate_limited';
  }

  let recipientClaimed: boolean;
  try {
    recipientClaimed = await claimRecipient(input.householdId, input.to, now);
  } catch (err) {
    await refundDailyAllowance(input.householdId, now).catch(() => undefined);
    throw err;
  }
  if (!recipientClaimed) {
    await refundDailyAllowance(input.householdId, now).catch((err) => {
      logger.warn({ err: (err as Error).message }, 'invite_email.refund_failed');
    });
    return 'recipient_cooldown';
  }

  const locale: EmailLocale = normalizeEmailLocale(input.locale);
  const { subject, text } = composeInviteEmail(
    {
      inviterName,
      householdName,
      joinUrl: input.joinUrl,
      expiresAt: input.expiresAt,
    },
    locale
  );

  let accepted = false;
  let threw: Error | null = null;
  try {
    accepted = await emailNotifier.sendEmail({ to: input.to, subject, text });
  } catch (err) {
    threw = err as Error;
  }

  if (!accepted) {
    // Neither a dry run nor a provider error consumed anything real, so give
    // the allowance and the address back rather than letting a broken
    // environment burn a household's daily quota.
    await Promise.all([
      refundDailyAllowance(input.householdId, now).catch(() => undefined),
      releaseRecipient(input.householdId, input.to).catch(() => undefined),
    ]);
    if (threw) {
      logger.warn(
        { err: threw.message, householdId: input.householdId },
        'invite_email.send_failed'
      );
      throw threw;
    }
    logger.info({ householdId: input.householdId }, 'invite_email.dry_run');
    return 'unavailable';
  }

  logger.info({ householdId: input.householdId, locale }, 'invite_email.accepted');
  return 'accepted';
}
