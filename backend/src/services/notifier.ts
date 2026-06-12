import webpush from 'web-push';
import { logger } from '../utils/logger.js';
import * as pushSubscriptions from './pushSubscriptions.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as emailNotifier from './emailNotifier.js';
import * as smsNotifier from './smsNotifier.js';

let configured = false;

/**
 * Initialise web-push with VAPID credentials. Same pattern as Sentry/SES:
 * if either key is missing, all browser-push sends become structured log
 * lines so devs can see what would have been delivered.
 */
function ensureWebPushConfigured(): boolean {
  if (configured) return true;
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT || 'mailto:noreply@family-greenhouse.example';
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

/**
 * The canonical shape we hand to channel-specific senders. Channels render it
 * differently (subject vs SMS body vs push payload) but the underlying fields
 * are the same so we can keep the fan-out logic dumb.
 */
export interface NotificationPayload {
  title: string;
  body: string;
  /** Optional deep link the email/push will reference. */
  url?: string;
  /** De-dupe tag for browser-push (replaces a previous notification with the same tag). */
  tag?: string;
}

/**
 * Per-recipient context the fan-out needs. Caller has typically already
 * fetched the user record so we don't re-query Cognito here.
 */
export interface NotificationRecipient {
  userId: string;
  email: string;
}

async function sendBrowserPush(userId: string, payload: NotificationPayload): Promise<void> {
  const subs = await pushSubscriptions.getUserSubscriptions(userId);
  if (subs.length === 0) return;
  if (!ensureWebPushConfigured()) {
    logger.info({ userId, count: subs.length, payload, msg: 'push_dry_run' }, 'push_dry_run');
    return;
  }
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload)
        );
      } catch (err) {
        const e = err as { statusCode?: number };
        // 404/410 means the browser dropped the subscription permanently.
        if (e.statusCode === 404 || e.statusCode === 410) {
          await pushSubscriptions.deleteSubscription(userId, sub.endpoint);
        } else {
          logger.warn({ err, userId, msg: 'push_failed' }, 'push_failed');
        }
      }
    })
  );
}

/**
 * Fan a notification across every channel the user has enabled. Failures in
 * one channel never block the others — we want a flaky SES region to still
 * leave the user with a working push.
 *
 * DND policy:
 *   - Inside DND, email + SMS are suppressed (they wake people up loudly).
 *   - Browser push is NOT suppressed — the OS already manages quiet hours
 *     better than we can, and browser push respects the OS setting.
 */
export async function sendToUser(
  recipient: NotificationRecipient,
  payload: NotificationPayload
): Promise<void> {
  const prefs = await notificationPrefs.getPreferences(recipient.userId);
  const inDnd = notificationPrefs.isInDndWindow(prefs);

  const work: Promise<void>[] = [];

  if (prefs.browser) {
    work.push(sendBrowserPush(recipient.userId, payload));
  }
  if (prefs.email && !inDnd) {
    work.push(
      emailNotifier
        .sendEmail({
          to: recipient.email,
          subject: payload.title,
          text: payload.url ? `${payload.body}\n\n${payload.url}` : payload.body,
        })
        .catch((err) =>
          logger.warn({ err, userId: recipient.userId, msg: 'email_failed' }, 'email_failed')
        )
    );
  }
  if (prefs.sms && prefs.phone && !inDnd) {
    if (!prefs.phoneVerified) {
      // SMS only ever goes to numbers their owner has confirmed — an
      // unverified number (incl. rows that predate verification) is a
      // structured-log skip, never a send.
      logger.info(
        { userId: recipient.userId, msg: 'sms_skipped_unverified' },
        'sms_skipped_unverified'
      );
    } else {
      work.push(
        smsNotifier
          .sendSms({ to: prefs.phone, text: `${payload.title}: ${payload.body}` })
          .catch((err) =>
            logger.warn({ err, userId: recipient.userId, msg: 'sms_failed' }, 'sms_failed')
          )
      );
    }
  }
  if (inDnd && (prefs.email || prefs.sms)) {
    logger.info({ userId: recipient.userId, msg: 'dnd_skipped' }, 'dnd_skipped');
  }

  await Promise.all(work);
}
