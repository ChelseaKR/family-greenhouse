/**
 * SES inbound forwarder. Receipt rule order: S3 action stores the raw MIME
 * at inbox/{messageId}, then this Lambda is invoked (Event) and re-sends the
 * message to FORWARD_TO via SendRawEmail.
 *
 * Header surgery (the standard aws-lambda-ses-forwarder approach): SES will
 * only send From a verified identity, so the original From moves to Reply-To
 * and From becomes the forwarder address; Return-Path/Sender/DKIM-Signature
 * are stripped so the new send doesn't carry a broken signature.
 *
 * FORWARD_TO comes from Secrets Manager via Terraform (data source -> env
 * var) so the personal destination address never lives in the repo.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';

const s3 = new S3Client({});
const ses = new SESClient({});

const BUCKET = process.env.MAIL_BUCKET;
const PREFIX = process.env.MAIL_PREFIX ?? 'inbox/';
const FORWARD_TO = process.env.FORWARD_TO;
const FROM_ADDRESS = process.env.FROM_ADDRESS;

const STRIP = /^(return-path|sender|dkim-signature|message-id):/i;

function rewrite(raw, originalRecipient) {
  const sep = raw.indexOf('\r\n\r\n') !== -1 ? '\r\n\r\n' : '\n\n';
  const splitAt = raw.indexOf(sep);
  const headerBlock = splitAt === -1 ? raw : raw.slice(0, splitAt);
  const body = splitAt === -1 ? '' : raw.slice(splitAt);
  const eol = sep === '\r\n\r\n' ? '\r\n' : '\n';

  // Unfold continuation lines so each logical header is one element.
  const lines = headerBlock.split(eol);
  const headers = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && headers.length > 0) {
      headers[headers.length - 1] += eol + line;
    } else {
      headers.push(line);
    }
  }

  let from = '';
  const kept = headers.filter((h) => {
    if (STRIP.test(h)) return false;
    if (/^from:/i.test(h)) {
      from = h.replace(/^from:\s*/i, '').replace(new RegExp(eol, 'g'), ' ');
      return false;
    }
    if (/^reply-to:/i.test(h)) return false; // replaced below
    return true;
  });

  // Display the original sender in the visible name; envelope sender is ours.
  const safeName = from
    .replace(/"/g, "'")
    .replace(/[\r\n]/g, ' ')
    .trim();
  kept.push(`From: "${safeName || 'Unknown sender'} (via ${originalRecipient})" <${FROM_ADDRESS}>`);
  if (from) kept.push(`Reply-To: ${from}`);
  kept.push(`X-Forwarded-For-Mailbox: ${originalRecipient}`);

  return kept.join(eol) + body;
}

export const handler = async (event) => {
  const record = event.Records?.[0]?.ses;
  if (!record) return { skipped: true };
  const messageId = record.mail.messageId;
  const recipient = record.receipt.recipients?.[0] ?? 'unknown@unknown';

  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${messageId}` }));
  const raw = await obj.Body.transformToString();

  await ses.send(
    new SendRawEmailCommand({
      Source: FROM_ADDRESS,
      Destinations: [FORWARD_TO],
      RawMessage: { Data: Buffer.from(rewrite(raw, recipient)) },
    })
  );

  console.log(JSON.stringify({ msg: 'mail_forwarded', messageId, recipient, to: 'redacted' }));
  return { forwarded: true, messageId };
};
