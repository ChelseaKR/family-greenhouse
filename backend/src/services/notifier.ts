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
  /**
   * One-line rendering of the same content for space-constrained channels.
   * SMS is truncated to a single 140-byte segment and a push body shows two
   * or three lines, so a caller whose `body` is a multi-line list (the daily
   * reminder) supplies a summary here. Omitted means `body` is already short
   * enough and is used as-is on every channel.
   */
  shortBody?: string;
  /** Optional deep link the email/push will reference. */
  url?: string;
  /** De-dupe tag for browser-push (replaces a previous notification with the same tag). */
  tag?: string;
}

/** `shortBody` when the caller supplied one, else the full body. */
function compactBody(payload: NotificationPayload): string {
  return payload.shortBody?.trim() || payload.body;
}

/**
 * Per-recipient context the fan-out needs. Caller has typically already
 * fetched the user record so we don't re-query Cognito here.
 */
export interface NotificationRecipient {
  userId: string;
  email: string;
}

export const NOTIFICATION_CHANNELS = ['browser', 'email', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * A channel result is explicit about why no provider call happened. Reminder
 * delivery uses `delivered` vs every other state to finalize or release that
 * channel's daily lease without conflating it with a successful sibling.
 */
export type ChannelDeliveryStatus = 'delivered' | 'failed' | 'suppressed' | 'disabled' | 'skipped';

export interface SendOptions {
  /**
   * Limit this fan-out to channels whose delivery leases the caller owns.
   * Omitted means the normal behavior: consider every channel.
   */
  channels?: readonly NotificationChannel[];
  /** Stable clock for DND-sensitive scheduled work and deterministic tests. */
  now?: Date;
  /**
   * A caller that already read preferences may pass the same snapshot used to
   * choose channel leases, avoiding a second DynamoDB read and plan drift.
   */
  preferences?: notificationPrefs.NotificationPreferences;
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
      // Defense in depth for rows written before endpoint validation shipped.
      // Never make an outbound request to a user-controlled/unknown origin.
      if (!pushSubscriptions.isAllowedPushEndpoint(sub.endpoint)) {
        logger.warn(
          { userId, endpointHost: safeEndpointHost(sub.endpoint) },
          'push_invalid_endpoint_removed'
        );
        await pushSubscriptions.deleteSubscription(userId, sub.endpoint).catch((cleanupErr) => {
          logger.warn(
            { err: cleanupErr, userId, msg: 'push_invalid_cleanup_failed' },
            'push_invalid_cleanup_failed'
          );
        });
        return;
      }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload),
          // Bound provider/network stalls so one hostile or degraded endpoint
          // cannot consume the whole reminder Lambda timeout.
          { timeout: 5_000 }
        );
        anyDelivered = true;
      } catch (err) {
        const e = err as { statusCode?: number };
        // 404/410 means the browser dropped the subscription permanently.
        if (e.statusCode === 404 || e.statusCode === 410) {
          // Cleanup is best-effort. A transient DynamoDB failure while
          // deleting one stale endpoint must not reject the entire browser
          // leg (and, before the fan-out isolation below, used to prevent the
          // same user's healthy email/SMS channels from running at all).
          await pushSubscriptions.deleteSubscription(userId, sub.endpoint).catch((cleanupErr) => {
            logger.warn(
              { err: cleanupErr, userId, msg: 'push_stale_cleanup_failed' },
              'push_stale_cleanup_failed'
            );
          });
        } else {
          logger.warn({ err, userId, msg: 'push_failed' }, 'push_failed');
        }
      }
    })
  );
  return anyDelivered;
}

function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return 'invalid';
  }
}

/**
 * Outcome of a `sendToUser` fan-out. Reminder delivery (see
 * `services/reminders.ts`) keys its per-channel markers off `channels` so one
 * successful provider never suppresses a retry for a failed or deferred
 * sibling:
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
  channels: Record<NotificationChannel, ChannelDeliveryStatus>;
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
  payload: NotificationPayload,
  options: SendOptions = {}
): Promise<SendResult> {
  const prefs = options.preferences ?? (await notificationPrefs.getPreferences(recipient.userId));
  const inDnd = notificationPrefs.isInDndWindow(prefs, options.now);
  const requested = new Set(options.channels ?? NOTIFICATION_CHANNELS);
  const channels: Record<NotificationChannel, ChannelDeliveryStatus> = {
    browser: requested.has('browser') ? 'disabled' : 'skipped',
    email: requested.has('email') ? 'disabled' : 'skipped',
    sms: requested.has('sms') ? 'disabled' : 'skipped',
  };

  // Start every enabled channel before awaiting any one of them. Browser
  // subscription reads, VAPID configuration, and stale-subscription cleanup
  // are all external failure points; none may prevent email/SMS from running.
  const work: Promise<void>[] = [];
  if (requested.has('browser') && prefs.browser) {
    channels.browser = 'failed';
    work.push(
      sendBrowserPush(recipient.userId, { ...payload, body: compactBody(payload) })
        .then((sent) => {
          channels.browser = sent ? 'delivered' : 'failed';
        })
        .catch((err) => {
          logger.warn({ err, userId: recipient.userId, msg: 'push_failed' }, 'push_failed');
          channels.browser = 'failed';
        })
    );
  }

  // Each loud-channel send resolves to whether it ACTUALLY sent (false on a
  // dry-run / unconfigured channel), so an enabled-but-unprovisioned SES/SNS
  // never masquerades as a delivery.
  if (requested.has('email') && prefs.email) {
    if (inDnd) {
      channels.email = 'suppressed';
    } else {
      channels.email = 'failed';
      work.push(
        emailNotifier
          .sendEmail({
            to: recipient.email,
            subject: payload.title,
            text: payload.url ? `${payload.body}\n\n${payload.url}` : payload.body,
          })
          .then((sent) => {
            channels.email = sent ? 'delivered' : 'failed';
          })
          .catch((err) => {
            logger.warn({ err, userId: recipient.userId, msg: 'email_failed' }, 'email_failed');
            channels.email = 'failed';
          })
      );
    }
  }
  if (requested.has('sms') && prefs.sms && prefs.phone) {
    if (!prefs.phoneVerified) {
      // SMS only ever goes to numbers their owner has confirmed — an
      // unverified number (incl. rows that predate verification) is a
      // structured-log skip, never a send.
      //
      // This must NOT be left at the initial 'disabled'. "The user turned SMS
      // off" and "the user asked for SMS but has no usable recipient" are
      // different states, and a consumer reading `channels.sms === 'disabled'`
      // as the former would report a reachability failure as a settled user
      // preference. `'skipped'` is the member that already means "requested,
      // but no provider call was possible".
      channels.sms = 'skipped';
      logger.info(
        { userId: recipient.userId, msg: 'sms_skipped_unverified' },
        'sms_skipped_unverified'
      );
    } else if (inDnd) {
      channels.sms = 'suppressed';
    } else {
      channels.sms = 'failed';
      work.push(
        smsNotifier
          .sendSms({ to: prefs.phone, text: `${payload.title}: ${compactBody(payload)}` })
          .then((sent) => {
            channels.sms = sent ? 'delivered' : 'failed';
          })
          .catch((err) => {
            logger.warn({ err, userId: recipient.userId, msg: 'sms_failed' }, 'sms_failed');
            channels.sms = 'failed';
          })
      );
    }
  }
  if (Object.values(channels).includes('suppressed')) {
    logger.info({ userId: recipient.userId, msg: 'dnd_skipped' }, 'dnd_skipped');
  }

  await Promise.all(work);
  const delivered = Object.values(channels).includes('delivered');

  // DND-suppressed-only: the user wants email/SMS, nothing actually went out,
  // and DND is the cause. (`delivered` already covers browser push delivering
  // during DND.)
  const dndSuppressedOnly = !delivered && Object.values(channels).includes('suppressed');
  return { delivered, dndSuppressedOnly, channels };
}
