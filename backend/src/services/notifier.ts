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

/**
 * Returns whether at least one browser-push notification was ACTUALLY
 * delivered — a configured send that resolved without the browser dropping
 * the subscription. A dry-run (VAPID unset), a user with no subscriptions, or
 * a user all of whose subscriptions are stale (404/410) all return false, so
 * `sendToUser` never counts an unconfigured or unreachable channel as a
 * delivery and burns the day's reminder slot for nothing.
 */
async function sendBrowserPush(userId: string, payload: NotificationPayload): Promise<boolean> {
  const subs = await pushSubscriptions.getUserSubscriptions(userId);
  if (subs.length === 0) return false;
  if (!ensureWebPushConfigured()) {
    logger.info({ userId, count: subs.length, payload, msg: 'push_dry_run' }, 'push_dry_run');
    // Dry-run is NOT a delivery: nothing left the building, so don't let it
    // claim the daily slot.
    return false;
  }
  let anyDelivered = false;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload)
        );
        anyDelivered = true;
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
  return anyDelivered;
}

/**
 * Outcome of a `sendToUser` fan-out. The reminder dedupe marker (see
 * `services/reminders.ts`) keys off this so it only "burns the day" when the
 * user was actually reachable:
 *
 *   - `delivered` — at least one channel ACTUALLY sent (a browser push that
 *     resolved, or an email/SMS that left the building). A dry-run on an
 *     unconfigured channel (SES/VAPID/SNS not provisioned) does NOT count, so
 *     the caller keeps retrying until a real send happens rather than burning
 *     the day's slot on a notification nobody received.
 *   - `dndSuppressedOnly` — the user has email and/or SMS enabled but NOTHING
 *     delivered, and the only reason the loud channels were skipped is the DND
 *     window. This is the case H1 exists for: a DND user who relies on
 *     email/SMS (no push) is reachable again once the window lifts, so the
 *     caller must NOT claim the daily slot and should retry on the next run.
 */
export interface SendResult {
  delivered: boolean;
  dndSuppressedOnly: boolean;
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
 *
 * Returns a `SendResult` describing whether anything was delivered and, if
 * not, whether the only thing standing in the way was the DND window — see
 * `SendResult`.
 */
export async function sendToUser(
  recipient: NotificationRecipient,
  payload: NotificationPayload
): Promise<SendResult> {
  const prefs = await notificationPrefs.getPreferences(recipient.userId);
  const inDnd = notificationPrefs.isInDndWindow(prefs);

  // Browser push runs first and synchronously resolves whether the user has a
  // subscription, so we can fold its actual delivery into `delivered`.
  let delivered = false;
  if (prefs.browser) {
    delivered = (await sendBrowserPush(recipient.userId, payload)) || delivered;
  }

  // Each loud-channel send resolves to whether it ACTUALLY sent (false on a
  // dry-run / unconfigured channel), so an enabled-but-unprovisioned SES/SNS
  // never masquerades as a delivery.
  const work: Promise<boolean>[] = [];

  if (prefs.email && !inDnd) {
    work.push(
      emailNotifier
        .sendEmail({
          to: recipient.email,
          subject: payload.title,
          text: payload.url ? `${payload.body}\n\n${payload.url}` : payload.body,
        })
        .catch((err) => {
          logger.warn({ err, userId: recipient.userId, msg: 'email_failed' }, 'email_failed');
          return false;
        })
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
          .catch((err) => {
            logger.warn({ err, userId: recipient.userId, msg: 'sms_failed' }, 'sms_failed');
            return false;
          })
      );
    }
  }
  if (inDnd && (prefs.email || prefs.sms)) {
    logger.info({ userId: recipient.userId, msg: 'dnd_skipped' }, 'dnd_skipped');
  }

  const loudResults = await Promise.all(work);
  if (loudResults.some(Boolean)) delivered = true;

  // DND-suppressed-only: the user wants email/SMS, nothing actually went out,
  // and DND is the cause. (`delivered` already covers browser push delivering
  // during DND.)
  const dndSuppressedOnly = !delivered && inDnd && (prefs.email || prefs.sms);
  return { delivered, dndSuppressedOnly };
}
