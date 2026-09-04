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
 */
import type { SNSEvent } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../../utils/dynamodb.js';
import { logger } from '../../utils/logger.js';
import * as emailSuppression from '../../services/emailSuppression.js';

/** How long a processed-event marker lives. Well past SNS's redrive window. */
const EVENT_MARKER_TTL_SECONDS = 7 * 24 * 60 * 60;

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
 * Claim one `(messageId, eventType)` pair. Returns false when another
 * delivery of the same notification already claimed it.
 *
 * A notification with no `messageId` cannot be de-duplicated; it is processed
 * anyway and logged, because losing a bounce is strictly worse than counting
 * a soft bounce twice.
 */
async function claimEvent(
  messageId: string | undefined,
  eventType: string,
  now: Date
): Promise<boolean> {
  if (!messageId) {
    logger.warn({ eventType }, 'email_events.missing_message_id');
    return true;
  }
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `EMAILEVENT#${messageId}`,
          SK: `TYPE#${eventType}`,
          entityType: 'EmailEventMarker',
          processedAt: now.toISOString(),
          ttl: Math.floor(now.getTime() / 1000) + EVENT_MARKER_TTL_SECONDS,
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
  if (!(await claimEvent(notification.mail?.messageId, kind, now))) {
    return { processed: 0, duplicate: 1, ignored: 0 };
  }

  for (const recipient of recipients) {
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
      continue;
    }
    if (kind === 'Delivery') {
      await emailSuppression.recordDelivery(recipient);
      continue;
    }
    // Bounce. `Permanent` is the mailbox saying it will never accept mail;
    // `Transient` and `Undetermined` both get the benefit of the doubt and
    // count against the rolling soft-bounce budget instead.
    const bounceType = notification.bounce?.bounceType ?? 'Undetermined';
    const detail = `${bounceType}/${notification.bounce?.bounceSubType ?? 'Unknown'}`;
    if (bounceType === 'Permanent') {
      await emailSuppression.recordHardBounce(recipient, detail, now);
      logger.warn({ detail }, 'email_events.hard_bounce');
    } else {
      const state = await emailSuppression.recordSoftBounce(recipient, detail, now);
      logger.info(
        { detail, softBounceCount: state.softBounceCount, state: state.state },
        'email_events.soft_bounce'
      );
    }
  }

  return { processed: recipients.length, duplicate: 0, ignored: 0 };
}

/**
 * SNS entrypoint. Records are processed in order; an exception propagates so
 * the whole invocation is retried (the per-event claim above makes that safe).
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
