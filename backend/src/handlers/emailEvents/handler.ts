/**
 * SES delivery-feedback consumer.
 *
 * NOT an HTTP route — same contract as `handlers/reminders/handler.ts`. The
 * SES configuration set (`infrastructure/modules/email/events.tf`) publishes
 * bounce / complaint / delivery events to an SNS topic, and SNS invokes this
 * Lambda asynchronously. Failures rethrow so Lambda's async retries run and a
 * genuinely stuck event lands in the shared DLQ rather than disappearing: a
 * dropped bounce is invisible by construction, which is the failure mode this
 * whole feature exists to remove.
 *
 * Two payload shapes reach us and both are handled:
 *   - configuration-set event publishing: `{ eventType, mail, bounce|complaint|delivery }`
 *   - the older identity-level notification: `{ notificationType, mail, ... }`
 *
 * SNS is at-least-once, and one of the three actions (the soft-bounce counter)
 * is not idempotent, so each `(messageId, eventType)` pair is claimed once
 * with a conditional write before it is applied.
 *
 * That claim is a LEASE, not a flag, and the distinction is the whole point:
 * a claim nothing can release turns the retry above into the thing that drops
 * the bounce. The claim is written `status: 'applying'` with a short lease,
 * released when the recipient loop throws, and only then finalized
 * `status: 'applied'` — so the retry re-applies the event instead of reading
 * its own abandoned marker as a duplicate and returning 200. Same shape as
 * `services/digest.ts` and `services/reminders.ts`, which lease their delivery
 * markers for exactly this reason.
 */
import type { SNSEvent } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { PutCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../../utils/dynamodb.js';
import { logger } from '../../utils/logger.js';
import * as emailSuppression from '../../services/emailSuppression.js';

/** How long a processed-event marker lives. Well past SNS's redrive window. */
const EVENT_MARKER_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * How long an unfinalized claim blocks a re-delivery of the same notification.
 * Long enough that two concurrent SNS deliveries cannot both apply the event,
 * short enough that a Lambda killed mid-loop (timeout, OOM) leaves a claim the
 * next delivery can reclaim rather than a permanent tombstone over a bounce.
 * Matches `DELIVERY_LEASE_SECONDS` in digest/reminders.
 */
const EVENT_LEASE_SECONDS = 5 * 60;

interface SesRecipient {
  emailAddress?: string;
}

interface SesFeedbackNotification {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; destination?: string[] };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: SesRecipient[];
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: SesRecipient[];
  };
  delivery?: { recipients?: string[] };
}

export interface EmailEventSummary {
  /** Events whose effect was applied to the suppression list. */
  processed: number;
  /** Events already applied by an earlier delivery of the same notification. */
  duplicate: number;
  /** Event types we deliberately do nothing with (Send, Open, Click, …). */
  ignored: number;
}

function recipientsOf(notification: SesFeedbackNotification, kind: string): string[] {
  if (kind === 'Bounce') {
    return (notification.bounce?.bouncedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter((address): address is string => typeof address === 'string' && address.length > 0);
  }
  if (kind === 'Complaint') {
    return (notification.complaint?.complainedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter((address): address is string => typeof address === 'string' && address.length > 0);
  }
  if (kind === 'Delivery') {
    return (notification.delivery?.recipients ?? []).filter(
      (address): address is string => typeof address === 'string' && address.length > 0
    );
  }
  return [];
}

/**
 * The outcome of trying to claim one `(messageId, eventType)` pair.
 *
 * `unclaimable` is not a failure: a notification with no `messageId` cannot be
 * de-duplicated, so it is applied without a claim (and with nothing to release
 * or finalize) because losing a bounce is strictly worse than counting a soft
 * bounce twice.
 */
type EventClaim =
  | { kind: 'claimed'; messageId: string; eventType: string; reservationId: string }
  | { kind: 'unclaimable' }
  | { kind: 'duplicate' };

function eventMarkerKey(messageId: string, eventType: string): { PK: string; SK: string } {
  return { PK: `EMAILEVENT#${messageId}`, SK: `TYPE#${eventType}` };
}

/**
 * Claim one `(messageId, eventType)` pair for the duration of the apply.
 *
 * The marker is written `status: 'applying'` with a lease, so it says "someone
 * is working on this", not "this is done". A duplicate is therefore only a
 * marker that has been finalized (no `status: 'applying'`) or one whose lease
 * is still live — an abandoned claim from a failed attempt is reclaimable.
 *
 * Markers written before this file leased its claims carry no `status`, so
 * they fail the condition and read as duplicates. That is the intended
 * reading: they were written by a version that applied the event immediately
 * after, and they age out on the 7-day TTL.
 */
async function claimEvent(
  messageId: string | undefined,
  eventType: string,
  now: Date
): Promise<EventClaim> {
  if (!messageId) {
    logger.warn({ eventType }, 'email_events.missing_message_id');
    return { kind: 'unclaimable' };
  }
  const reservationId = randomUUID();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...eventMarkerKey(messageId, eventType),
          entityType: 'EmailEventMarker',
          status: 'applying',
          reservationId,
          leaseExpiresAt: nowEpoch + EVENT_LEASE_SECONDS,
          claimedAt: now.toISOString(),
          ttl: nowEpoch + EVENT_MARKER_TTL_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(PK) OR (#status = :applying AND leaseExpiresAt <= :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':applying': 'applying', ':now': nowEpoch },
      })
    );
    return { kind: 'claimed', messageId, eventType, reservationId };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { kind: 'duplicate' };
    }
    throw err;
  }
}

/**
 * Give the claim back after a failed apply, so the Lambda retry that follows
 * re-applies the event instead of finding this attempt's own marker.
 *
 * Guarded on the reservation id: if our lease expired and another delivery
 * reclaimed the event, that claim is theirs and must not be deleted.
 */
async function releaseEvent(claim: {
  messageId: string;
  eventType: string;
  reservationId: string;
}): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: eventMarkerKey(claim.messageId, claim.eventType),
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': claim.reservationId },
    })
  );
}

/**
 * Mark the event applied. Only now is a re-delivery a genuine duplicate: the
 * suppression writes have returned, so `status: 'applied'` records an effect
 * rather than an intention.
 */
async function finalizeEvent(
  claim: { messageId: string; eventType: string; reservationId: string },
  now: Date
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: eventMarkerKey(claim.messageId, claim.eventType),
      UpdateExpression:
        'SET #status = :applied, processedAt = :processedAt REMOVE leaseExpiresAt, reservationId',
      ConditionExpression: '#status = :applying AND reservationId = :reservationId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':applied': 'applied',
        ':applying': 'applying',
        ':processedAt': now.toISOString(),
        ':reservationId': claim.reservationId,
      },
    })
  );
}

/**
 * Apply one parsed SES feedback notification. Exported for unit tests and for
 * the local dev server, which has no SNS to receive from.
 */
export async function applyNotification(
  notification: SesFeedbackNotification,
  now: Date = new Date()
): Promise<EmailEventSummary> {
  const kind = notification.eventType ?? notification.notificationType ?? '';
  const recipients = recipientsOf(notification, kind);
  if (recipients.length === 0) {
    // No recipient to act on. Named rather than counted silently: `Reject` and
    // `RenderingFailure` mean SES refused the message outright, and a send
    // that never left is exactly the kind of failure this whole feature exists
    // to stop looking like a success.
    logger.info({ kind }, 'email_events.no_action');
    return { processed: 0, duplicate: 0, ignored: 1 };
  }
  const claim = await claimEvent(notification.mail?.messageId, kind, now);
  if (claim.kind === 'duplicate') {
    return { processed: 0, duplicate: 1, ignored: 0 };
  }

  // Every recipient is attempted even after one throws. The claim is per
  // `(messageId, eventType)` but the effect is per recipient: a bounce for four
  // addresses that fails on the third must still suppress the fourth, and a
  // recipient whose write fails every time must not indefinitely deny the other
  // three theirs. The first failure is rethrown below, once the loop is done.
  let firstFailure: Error | null = null;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      await applyToRecipient(notification, kind, recipient, now);
    } catch (err) {
      failed += 1;
      // Recipient addresses stay out of the logs, as everywhere else here.
      firstFailure ??= err instanceof Error ? err : new Error(String(err));
      logger.error({ err: (err as Error).message, kind }, 'email_events.recipient_failed');
    }
  }

  if (firstFailure) {
    if (claim.kind === 'claimed') {
      await releaseEvent(claim).catch((cleanupErr: unknown) => {
        // The claim outlived the attempt that failed. Say so at error level:
        // until its lease expires, the Lambda retry reads it as a duplicate,
        // which is precisely the invisible dropped bounce this file exists to
        // prevent.
        logger.error(
          { err: (cleanupErr as Error).message, kind },
          'email_events.claim_release_failed'
        );
      });
    }
    logger.error({ kind, failed, recipients: recipients.length }, 'email_events.apply_failed');
    throw firstFailure;
  }

  if (claim.kind === 'claimed') {
    await finalizeEvent(claim, now).catch((err: unknown) => {
      // The suppression writes landed; only the bookkeeping did not. Throwing
      // here would alarm on work that was actually done, so it is a warning:
      // the lease expires on its own and a later re-delivery re-applies writes
      // that are idempotent apart from the soft-bounce counter — the trade this
      // file already names above.
      logger.warn({ err: (err as Error).message, kind }, 'email_events.claim_finalize_failed');
    });
  }

  return { processed: recipients.length, duplicate: 0, ignored: 0 };
}

/** Apply one notification's effect to one recipient. Throws on write failure. */
async function applyToRecipient(
  notification: SesFeedbackNotification,
  kind: string,
  recipient: string,
  now: Date
): Promise<void> {
  if (kind === 'Complaint') {
    await emailSuppression.recordComplaint(
      recipient,
      notification.complaint?.complaintFeedbackType,
      now
    );
    logger.warn(
      { feedbackType: notification.complaint?.complaintFeedbackType },
      'email_events.complaint'
    );
    return;
  }
  if (kind === 'Delivery') {
    await emailSuppression.recordDelivery(recipient);
    return;
  }
  // Bounce. `Permanent` is the mailbox saying it will never accept mail;
  // `Transient` and `Undetermined` both get the benefit of the doubt and
  // count against the rolling soft-bounce budget instead.
  const bounceType = notification.bounce?.bounceType ?? 'Undetermined';
  const detail = `${bounceType}/${notification.bounce?.bounceSubType ?? 'Unknown'}`;
  if (bounceType === 'Permanent') {
    await emailSuppression.recordHardBounce(recipient, detail, now);
    logger.warn({ detail }, 'email_events.hard_bounce');
    return;
  }
  const state = await emailSuppression.recordSoftBounce(recipient, detail, now);
  logger.info(
    { detail, softBounceCount: state.softBounceCount, state: state.state },
    'email_events.soft_bounce'
  );
}

/**
 * SNS entrypoint. Records are processed in order; an exception propagates so
 * the whole invocation is retried. The leased claim above is what makes that
 * retry mean something: a failed attempt hands its claim back, so the retry
 * re-applies the event rather than reading the marker its own failure left.
 */
export const handler = async (event: SNSEvent): Promise<EmailEventSummary> => {
  const summary: EmailEventSummary = { processed: 0, duplicate: 0, ignored: 0 };
  for (const record of event.Records ?? []) {
    let notification: SesFeedbackNotification;
    try {
      notification = JSON.parse(record.Sns.Message) as SesFeedbackNotification;
    } catch (err) {
      // Unparseable payloads are not retryable — retrying cannot make the
      // JSON valid — but they ARE reported rather than counted as handled.
      logger.error({ err: (err as Error).message }, 'email_events.unparseable_message');
      summary.ignored += 1;
      continue;
    }
    const applied = await applyNotification(notification);
    summary.processed += applied.processed;
    summary.duplicate += applied.duplicate;
    summary.ignored += applied.ignored;
  }
  logger.info({ ...summary }, 'email_events.batch_complete');
  return summary;
};
