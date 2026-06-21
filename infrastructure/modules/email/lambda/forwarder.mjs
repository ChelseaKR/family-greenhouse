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

export function rewrite(rawBytes, originalRecipient) {
  // Split header/body on the RAW BYTES and leave the body untouched. Reading
  // the whole message as a UTF-8 string and re-encoding it (the old approach)
  // corrupted any non-UTF-8 octets — 8-bit MIME, Content-Transfer-Encoding:
  // binary, legacy-charset bodies, binary attachment parts — turning them into
  // U+FFFD before SendRawEmail. Only the (ASCII, RFC 5322) header block is
  // decoded and rewritten; the body bytes forward verbatim.
  const crlf = Buffer.from('\r\n\r\n');
  let splitAt = rawBytes.indexOf(crlf);
  let sepLen = 4;
  if (splitAt === -1) {
    splitAt = rawBytes.indexOf(Buffer.from('\n\n'));
    sepLen = 2;
  }
  const headerBytes = splitAt === -1 ? rawBytes : rawBytes.subarray(0, splitAt);
  const bodyBytes = splitAt === -1 ? Buffer.alloc(0) : rawBytes.subarray(splitAt + sepLen);
  const eol = sepLen === 4 ? '\r\n' : '\n';
  const sep = sepLen === 4 ? '\r\n\r\n' : '\n\n';

  // latin1 is a lossless 1:1 byte<->char mapping, and headers are ASCII, so
  // decoding/encoding the header block this way never alters a byte.
  const headerBlock = headerBytes.toString('latin1');

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

  return Buffer.concat([Buffer.from(kept.join(eol) + sep, 'latin1'), bodyBytes]);
}

export const handler = async (event) => {
  const record = event.Records?.[0]?.ses;
  if (!record) return { skipped: true };
  const messageId = record.mail?.messageId;
  const recipient = record.receipt?.recipients?.[0] ?? 'unknown@unknown';

  // SES stamps spam/virus scan verdicts on the receipt (the receipt rule sets
  // scan_enabled = true). Refuse to relay anything that FAILED the virus or
  // spam scan: this forwarder re-sends from our DKIM-aligned domain, so passing
  // malware/phishing through would launder it under our domain's reputation
  // straight into the maintainer's inbox. We gate ONLY on virus/spam — not
  // DKIM/SPF/DMARC, which legitimately fail for plenty of forwarded list mail.
  // A FAIL is an expected verdict, not a processing error, so we drop and
  // return cleanly (no throw → no retry, no DLQ).
  const spam = record.receipt?.spamVerdict?.status;
  const virus = record.receipt?.virusVerdict?.status;
  if (spam === 'FAIL' || virus === 'FAIL') {
    console.log(
      JSON.stringify({ msg: 'mail_dropped_scan_fail', messageId, recipient, spam, virus })
    );
    return { dropped: true, reason: 'scan_failed' };
  }

  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${messageId}` })
    );
    // Read the raw MIME as BYTES, not a UTF-8 string — see rewrite().
    const rawBytes = Buffer.from(await obj.Body.transformToByteArray());

    await ses.send(
      new SendRawEmailCommand({
        Source: FROM_ADDRESS,
        Destinations: [FORWARD_TO],
        RawMessage: { Data: rewrite(rawBytes, recipient) },
      })
    );

    console.log(JSON.stringify({ msg: 'mail_forwarded', messageId, recipient, to: 'redacted' }));
    return { forwarded: true, messageId };
  } catch (err) {
    // Log loudly AND rethrow. This Lambda is invoked asynchronously
    // (invocation_type = Event), so a throw is what routes the message to the
    // forwarder DLQ (and trips the depth alarm) for inspection + redrive.
    // Swallowing the error here would silently lose security@/abuse@ mail.
    console.error(
      JSON.stringify({ msg: 'mail_forward_failed', messageId, recipient, error: err?.message })
    );
    throw err;
  }
};
