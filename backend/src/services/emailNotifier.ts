import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../utils/logger.js';
import * as emailSuppression from './emailSuppression.js';
import { buildRawMessage } from './email/mime.js';

let cachedClient: SESClient | null = null;

function ses(): SESClient {
  if (!cachedClient) {
    cachedClient = new SESClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return cachedClient;
}

export interface EmailMessage {
  /** Recipient address, must be a verified identity in SES sandbox mode. */
  to: string;
  subject: string;
  /**
   * Plain-text body. Required for every message — the text part is a first
   * class alternative, not a stripped copy of the HTML, and a message with
   * only an HTML part is both a deliverability and an accessibility problem.
   */
  text: string;
  /**
   * HTML body. When present the message goes out as `multipart/alternative`
   * with both parts. Composers build this with `services/email/template.ts`,
   * which escapes every interpolated value; nothing else may pass HTML here.
   */
  html?: string;
  /**
   * Extra RFC 5322 headers, e.g. `List-Unsubscribe` /
   * `List-Unsubscribe-Post` on non-transactional mail. Values are sanitized
   * for CR/LF in the MIME builder.
   */
  headers?: Record<string, string>;
}

/**
 * Why a send did or did not reach SES.
 *
 *   - `sent` — SES returned a message ID. See `EmailAcceptance` for what that
 *     does and does not mean.
 *   - `dry_run` — `SES_FROM_EMAIL` isn't configured (local dev, tests).
 *   - `suppressed` — the address is on the suppression list: it hard-bounced,
 *     the recipient filed a complaint, or it soft-bounced past the budget.
 *   - `suppression_unknown` — the suppression store was unreachable, so we
 *     could not tell. We do not send: mailing a suppressed address is the
 *     expensive mistake, and every caller here retries on a later run.
 */
export type EmailAcceptanceReason = 'sent' | 'dry_run' | 'suppressed' | 'suppression_unknown';

/**
 * The result of handing a message to SES.
 *
 * `accepted` means SES took custody of the message — NOT that anyone received
 * it. Delivery is asynchronous and is reported later, out of band, by the
 * configuration set's bounce/complaint/delivery events
 * (`handlers/emailEvents/handler.ts`). Nothing in this module can tell you a
 * message was delivered, so nothing in this module says so.
 */
export interface EmailAcceptance {
  accepted: boolean;
  reason: EmailAcceptanceReason;
}

/**
 * Hand one email to SES.
 *
 * Three things happen before the send:
 *
 *   1. The recipient is checked against the suppression list. A hard-bounced
 *      or complaining address is never mailed again — sustained bounces cost
 *      the whole domain its reputation, password-reset mail included.
 *   2. `ConfigurationSetName` is attached (when configured) so SES publishes
 *      bounce/complaint/delivery events for the message. Without it the
 *      feedback loop has nothing to consume.
 *   3. `Reply-To` points at the forwarded `support@` mailbox, so a reply
 *      reaches a human instead of the send-only `hello@` sender.
 *
 * No-ops with a structured log line when `SES_FROM_EMAIL` isn't configured,
 * which is the normal state for local dev and unit tests. The dev experience
 * is the same regardless of channel: you see what would have gone out in the
 * logs.
 *
 * ## Why SendRawEmail
 *
 * This used `SendEmailCommand`, whose API surface is `Source` / `Destination`
 * / `Message` and nothing else: it cannot set a single custom header. That
 * made `List-Unsubscribe` — required in practice by Gmail's and Yahoo's bulk
 * sender rules for the weekly digest and the annual recap — impossible to
 * add, and forced every email to be text-only. Raw MIME buys both the header
 * surface and the multipart body without adding `@aws-sdk/client-sesv2` to
 * the bundle, and `ses:SendRawEmail` is already in the Lambda's IAM policy.
 * ADR 0021 records the reasoning, including the phishing rationale the old
 * text-only policy rested on and how each part of it is now mitigated.
 *
 * `Reply-To` moves from `SendEmailCommand`'s `ReplyToAddresses` parameter
 * into the MIME headers, because `SendRawEmailCommand` has no such parameter
 * — the raw message IS the headers. `ConfigurationSetName` stays a command
 * parameter; that one exists on both.
 */
export async function sendEmailAccepted(msg: EmailMessage): Promise<EmailAcceptance> {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    logger.info(
      { msg: 'email_dry_run', to: msg.to, subject: msg.subject, html: Boolean(msg.html) },
      'email_dry_run'
    );
    return { accepted: false, reason: 'dry_run' };
  }

  const status = await emailSuppression.checkAddress(msg.to);
  if (status.status === 'suppressed') {
    logger.warn(
      { msg: 'email_suppressed', subject: msg.subject, reason: status.state.reason },
      'email_suppressed'
    );
    return { accepted: false, reason: 'suppressed' };
  }
  if (status.status === 'unknown') {
    // Not "fine" and not "blocked" — unknown. Declining here costs one
    // deferred email; guessing costs a bounce we already know how to avoid.
    logger.warn(
      { msg: 'email_suppression_unknown', subject: msg.subject },
      'email_suppression_unknown'
    );
    return { accepted: false, reason: 'suppression_unknown' };
  }

  const configurationSet = process.env.SES_CONFIGURATION_SET?.trim();
  const replyTo = process.env.SES_REPLY_TO?.trim();
  const raw = buildRawMessage({
    from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    replyTo: replyTo || undefined,
    headers: msg.headers,
  });
  await ses().send(
    new SendRawEmailCommand({
      Source: from,
      Destinations: [msg.to],
      ConfigurationSetName: configurationSet || undefined,
      RawMessage: { Data: raw },
    })
  );
  return { accepted: true, reason: 'sent' };
}

/**
 * Boolean shorthand for `sendEmailAccepted`.
 *
 * `true` means **SES accepted the message**, not that it was delivered. Read
 * it as "the send attempt happened"; a mailbox that no longer exists still
 * returns `true` here and reports its bounce minutes later. Callers that keep
 * a per-day / per-week "already sent" marker are relying on exactly that
 * weaker guarantee, which is why the suppression check above runs BEFORE the
 * send: an address known to be undeliverable never reaches this point, so no
 * marker can be finalized against one.
 *
 * `false` means nothing left the building — an unconfigured channel, a
 * suppressed address, or an unreadable suppression store — so callers must not
 * count it as a delivery and burn the recipient's slot for the day.
 */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const { accepted } = await sendEmailAccepted(msg);
  return accepted;
}
