import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';

/**
 * Per-user notification channel preferences. Stored under the user's partition
 * with `SK = "PREFS"` so we can fetch them with a single point read alongside
 * any other user-scoped row when we need to.
 *
 * `email` mirrors the user's Cognito email (so we don't store the same address
 * twice). `phone` is opt-in; clients submit an E.164 string and we trust it
 * after schema validation. SMS verification (sending a code, confirming) is
 * still TODO — see `docs/notifications.md`.
 */
export interface NotificationPreferences {
  userId: string;
  /** Browser notifications are governed by `Notification.permission`; we still
   *  record the user's intent so a different device can avoid prompting again. */
  browser: boolean;
  email: boolean;
  sms: boolean;
  /** E.164 phone, e.g. "+15551234567". Empty string when SMS is off. */
  phone: string;
  /**
   * Optional do-not-disturb window. "HH:MM" 24-hour pairs in the user's IANA
   * timezone. Both empty = no quiet hours.
   *
   * If `dndStart` > `dndEnd` we treat it as wrapping past midnight (e.g.
   * 22:00 → 07:00). Reminder dispatch checks the current local hour against
   * this window and silently skips channels that aren't push-with-grouping
   * (push respects OS DND so we don't double-mute).
   */
  dndStart: string;
  dndEnd: string;
  /** IANA timezone (e.g. "America/New_York") to evaluate DND against. */
  timezone: string;
  /** Opt-in to seasonal pest pressure heads-ups. Off by default — these
   *  alerts are coarse and we want explicit consent before adding to the
   *  notification volume. */
  pestAlerts: boolean;
  updatedAt: string;
}

const DEFAULTS: Omit<NotificationPreferences, 'userId' | 'updatedAt'> = {
  browser: false,
  email: true, // we have the user's email already, default-on is friendly
  sms: false,
  phone: '',
  dndStart: '',
  dndEnd: '',
  timezone: 'UTC',
  pestAlerts: false,
};

/**
 * Read the user's prefs row, returning a default record if none exists yet.
 * Never returns null — the caller can always treat the result as the source
 * of truth for "what channels should we send to."
 */
export async function getPreferences(userId: string): Promise<NotificationPreferences> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: 'PREFS' },
    })
  );
  const item = result.Item;
  if (!item) {
    return {
      userId,
      ...DEFAULTS,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    userId: item.userId as string,
    browser: Boolean(item.browser),
    email: Boolean(item.email),
    sms: Boolean(item.sms),
    phone: (item.phone as string) ?? '',
    dndStart: (item.dndStart as string) ?? '',
    dndEnd: (item.dndEnd as string) ?? '',
    timezone: (item.timezone as string) ?? 'UTC',
    pestAlerts: Boolean(item.pestAlerts),
    updatedAt: (item.updatedAt as string) ?? '',
  };
}

/**
 * True iff "now" falls inside the user's DND window. Caller passes the user's
 * timezone so this stays a pure function (no global state on Date).
 */
export function isInDndWindow(prefs: NotificationPreferences, now = new Date()): boolean {
  if (!prefs.dndStart || !prefs.dndEnd) return false;
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: prefs.timezone || 'UTC',
  });
  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const nowMins = hour * 60 + minute;
  const [sh, sm] = prefs.dndStart.split(':').map(Number);
  const [eh, em] = prefs.dndEnd.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  if (startMins === endMins) return false;
  if (startMins < endMins) {
    // Same-day window, e.g. 13:00 → 15:00.
    return nowMins >= startMins && nowMins < endMins;
  }
  // Wraps past midnight, e.g. 22:00 → 07:00.
  return nowMins >= startMins || nowMins < endMins;
}

/**
 * Replace the user's prefs row. We always write all fields so partial update
 * payloads don't accidentally re-enable SMS the user disabled in another
 * session.
 */
export async function setPreferences(
  prefs: Omit<NotificationPreferences, 'updatedAt'>
): Promise<NotificationPreferences> {
  const updated: NotificationPreferences = {
    ...prefs,
    // SMS off ⇒ wipe the phone number so we don't leak it on the next read.
    phone: prefs.sms ? prefs.phone : '',
    timezone: prefs.timezone || 'UTC',
    updatedAt: new Date().toISOString(),
  };
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${prefs.userId}`,
        SK: 'PREFS',
        entityType: 'NotificationPreferences',
        ...updated,
      },
    })
  );
  return updated;
}
