import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../utils/logger.js';

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
  /** Plain-text body. We deliberately don't ship HTML email yet — keeps the
   *  templating story simple and avoids a whole class of phishing spoof. */
  text: string;
}

/**
 * Send a transactional email via SES. No-ops with a structured log line when
 * `SES_FROM_EMAIL` isn't configured, which is the normal state for local dev
 * and unit tests. The dev experience is the same regardless of channel: you
 * see what would have gone out in the logs.
 *
 * Returns `true` only when a real send was attempted; a dry-run returns
 * `false` so callers (the reminder fan-out) don't count an unconfigured
 * channel as a delivery and silently burn the day's slot.
 */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    logger.info({ msg: 'email_dry_run', to: msg.to, subject: msg.subject }, 'email_dry_run');
    return false;
  }
  await ses().send(
    new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [msg.to] },
      Message: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: { Text: { Data: msg.text, Charset: 'UTF-8' } },
      },
    })
  );
  return true;
}
