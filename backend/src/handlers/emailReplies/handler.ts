/**
 * SES inbound consumer for replies to reminder emails (#667, ADR 0031).
 *
 * NOT an HTTP route — same contract as `handlers/emailEvents/handler.ts`. The
 * `reply-to-act` receipt rule (`infrastructure/modules/api/main.tf`, created
 * only when `email_reply_actions_enabled` is true) matches every
 * `care+<label>@<domain>` recipient, stores the raw message under
 * `replies/<messageId>` in the inbound-mail bucket, then invokes this Lambda
 * asynchronously with the SES receipt event (headers and verdicts, no body).
 *
 * All of the deciding is in `services/emailReplies.ts`. This file adapts the
 * event, fetches the body only when that service asks for it, and deletes the
 * stored copy once the message has been handled: a reply is kept exactly as
 * long as it takes to read one line of it (the bucket's `replies/` lifecycle
 * rule is the backstop for a message this code never reached).
 *
 * Failures rethrow, so Lambda's async retries run and a message that still
 * cannot be handled lands in the shared dead-letter queue rather than
 * vanishing — a reply we could not read must not look like one we ignored.
 */
import type { SESEvent, SESEventRecord } from 'aws-lambda';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { logger } from '../../utils/logger.js';
import { handleInboundReply, type ReplyResult } from '../../services/emailReplies.js';

/** Only the start of a message can hold the command (the first line above the
 *  quoted reminder), and every client puts the text part before any
 *  attachment. One ranged read bounds memory and time for a reply that
 *  arrives with photos attached. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** SES message ids are alphanumerics and hyphens; anything else is not used
 *  to build an object key. */
const MESSAGE_ID = /^[A-Za-z0-9-]{1,128}$/;

let cachedS3: S3Client | null = null;
function s3(): S3Client {
  cachedS3 ??= new S3Client({});
  return cachedS3;
}

function objectKey(messageId: string): string | null {
  const bucket = process.env.EMAIL_REPLY_BUCKET?.trim();
  if (!bucket || !MESSAGE_ID.test(messageId)) return null;
  return `${process.env.EMAIL_REPLY_PREFIX?.trim() || 'replies/'}${messageId}`;
}

async function loadBody(messageId: string): Promise<Buffer> {
  const bucket = process.env.EMAIL_REPLY_BUCKET?.trim();
  const key = objectKey(messageId);
  if (!bucket || !key) throw new Error('email_reply.bucket_not_configured');
  const object = await s3().send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${MAX_BODY_BYTES - 1}` })
  );
  if (!object.Body) throw new Error('email_reply.empty_object');
  return Buffer.from(await object.Body.transformToByteArray());
}

async function deleteStoredCopy(messageId: string): Promise<void> {
  const bucket = process.env.EMAIL_REPLY_BUCKET?.trim();
  const key = objectKey(messageId);
  if (!bucket || !key) return;
  await s3()
    .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    .catch((err: unknown) => {
      // Not a failure of the reply: the lifecycle rule expires it anyway.
      logger.warn({ err: (err as Error).message }, 'email_reply.stored_copy_delete_failed');
    });
}

export async function handleRecord(record: SESEventRecord): Promise<ReplyResult> {
  const { mail, receipt } = record.ses;
  const result = await handleInboundReply({
    sesMessageId: mail.messageId,
    recipients: receipt.recipients ?? [],
    from: mail.commonHeaders?.from,
    messageId: mail.commonHeaders?.messageId,
    verdicts: {
      spam: receipt.spamVerdict?.status,
      virus: receipt.virusVerdict?.status,
      dmarc: receipt.dmarcVerdict?.status,
    },
    loadBody: () => loadBody(mail.messageId),
  });
  await deleteStoredCopy(mail.messageId);
  return result;
}

export const handler = async (event: SESEvent): Promise<{ handled: number }> => {
  let handled = 0;
  for (const record of event.Records ?? []) {
    if (!record?.ses?.mail?.messageId) {
      logger.warn(
        { msg: 'email_reply.record_without_message_id' },
        'email_reply.record_without_message_id'
      );
      continue;
    }
    const result = await handleRecord(record);
    logger.info(
      { disposition: result.disposition, replied: result.replied, msg: 'email_reply.handled' },
      'email_reply.handled'
    );
    handled += 1;
  }
  return { handled };
};
