import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { logger } from '../utils/logger.js';

let cachedClient: SNSClient | null = null;

function sns(): SNSClient {
  if (!cachedClient) {
    cachedClient = new SNSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return cachedClient;
}

const E164 = /^\+[1-9]\d{6,14}$/;

export interface SmsMessage {
  /** Destination phone in E.164 format (e.g. +15551234567). */
  to: string;
  /** UTF-8 text. SNS truncates >1600 bytes — we cap aggressively below. */
  text: string;
}

/**
 * Send a one-shot SMS via SNS. Dry-run logs and returns when SNS isn't
 * configured (no `SMS_NOTIFICATIONS_ENABLED=1` env flag). We require the
 * explicit flag rather than inferring from credentials because SNS direct-
 * to-phone is not free and we don't want a misconfigured staging stack to
 * burn through real money on test runs.
 *
 * Returns `true` only when a real send was attempted; a dry-run returns
 * `false` so the reminder fan-out doesn't treat an unconfigured channel as a
 * delivery and burn the day's slot.
 */
export async function sendSms(msg: SmsMessage): Promise<boolean> {
  if (!E164.test(msg.to)) {
    throw new Error(`Phone number must be E.164 format, got: ${msg.to}`);
  }
  // SMS messages are billed per ~140-byte segment; trim to keep it to one.
  const text = msg.text.slice(0, 140);

  if (process.env.SMS_NOTIFICATIONS_ENABLED !== '1') {
    // Never log destinations or message bodies here. Verification messages
    // contain both a phone number and a live one-time code.
    logger.info({ msg: 'sms_dry_run' }, 'sms_dry_run');
    return false;
  }

  await sns().send(
    new PublishCommand({
      PhoneNumber: msg.to,
      Message: text,
      MessageAttributes: {
        // Transactional > Promotional gets you better delivery rates and
        // cost-per-message. Reminders are transactional.
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: 'Transactional',
        },
      },
    })
  );
  return true;
}
