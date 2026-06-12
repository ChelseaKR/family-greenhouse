import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import createHttpError from 'http-errors';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import * as smsNotifier from './smsNotifier.js';

/**
 * Per-user notification channel preferences. Stored under the user's partition
 * with `SK = "PREFS"` so we can fetch them with a single point read alongside
 * any other user-scoped row when we need to.
 *
 * `email` mirrors the user's Cognito email (so we don't store the same address
 * twice). `phone` is opt-in; clients submit an E.164 string and it must be
 * verified (code over SMS — `startPhoneVerification` / `confirmPhoneVerification`
 * below) before SMS delivery is allowed.
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
  /**
   * Weekly "plants at risk" digest email. Defaults ON whenever email
   * notifications are enabled (the digest is an email, so it inherits the
   * email channel's consent); a user who turned email off gets neither.
   */
  weeklyDigest: boolean;
  /**
   * True once the current `phone` was confirmed via SMS code. Never settable
   * directly through `setPreferences` — only `confirmPhoneVerification`
   * stamps it, and changing the phone number clears it.
   */
  phoneVerified: boolean;
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
  weeklyDigest: true, // default-on iff email is on; DEFAULTS.email is true
  phoneVerified: false,
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
    // Read-time defaulting for rows written before the digest pref existed:
    // default-on only when the user already accepts email notifications.
    weeklyDigest:
      item.weeklyDigest === undefined ? Boolean(item.email) : Boolean(item.weeklyDigest),
    phoneVerified: Boolean(item.phoneVerified),
    updatedAt: (item.updatedAt as string) ?? '',
  };
}

/**
 * Validate an IANA timezone. Primary check is the runtime's canonical list
 * (`Intl.supportedValuesOf`); we fall back to letting Intl resolve the name
 * because `supportedValuesOf` omits some accepted aliases (e.g. links like
 * "Etc/GMT" variants).
 */
let supportedTimeZones: Set<string> | null = null;
export function isValidTimeZone(tz: string): boolean {
  try {
    if (!supportedTimeZones) {
      supportedTimeZones = new Set(Intl.supportedValuesOf('timeZone'));
    }
    if (supportedTimeZones.has(tz)) return true;
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff "now" falls inside the user's DND window. Caller passes the user's
 * timezone so this stays a pure function (no global state on Date).
 *
 * Defensive: a corrupt/legacy timezone makes Intl throw. We fail open ("not
 * in DND") so the user still gets their reminder instead of the exception
 * aborting the whole household's reminder run.
 */
export function isInDndWindow(prefs: NotificationPreferences, now = new Date()): boolean {
  if (!prefs.dndStart || !prefs.dndEnd) return false;
  try {
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
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, userId: prefs.userId, timezone: prefs.timezone },
      'notification_prefs.dnd_check_failed'
    );
    return false;
  }
}

/** What callers may set. `phoneVerified` is derived, never accepted as input;
 *  `weeklyDigest` is optional so older clients keep the stored/derived value. */
export type PreferencesInput = Omit<
  NotificationPreferences,
  'updatedAt' | 'phoneVerified' | 'weeklyDigest'
> & { weeklyDigest?: boolean };

/**
 * Replace the user's prefs row. We always write all fields so partial update
 * payloads don't accidentally re-enable SMS the user disabled in another
 * session.
 *
 * Phone lifecycle: the phone number now persists independently of the SMS
 * toggle (it used to be wiped whenever SMS was off) because verification
 * gives it an explicit lifecycle — wiping it would force re-verification on
 * every toggle. Users remove it by clearing the field. Changing or clearing
 * the number clears `phoneVerified`; enabling SMS on an unverified number is
 * rejected unless SMS was already on for that same number (grandfathered
 * pre-verification rows keep saving, though delivery still skips them —
 * see `notifier.sendToUser`).
 */
export async function setPreferences(prefs: PreferencesInput): Promise<NotificationPreferences> {
  const timezone = prefs.timezone || 'UTC';
  // Reject bad IANA names at write time. A bad stored timezone used to make
  // Intl throw inside the reminder run's DND check, aborting reminders for
  // every member processed after the bad one.
  if (!isValidTimeZone(timezone)) {
    throw createHttpError(400, `Unknown timezone: ${timezone}`);
  }
  const existing = await getPreferences(prefs.userId);
  // Verified status carries over only while the number is unchanged.
  const phoneVerified =
    prefs.phone !== '' && existing.phoneVerified && existing.phone === prefs.phone;
  if (prefs.sms && !phoneVerified && !(existing.sms && existing.phone === prefs.phone)) {
    throw createHttpError(400, 'Phone number must be verified before enabling SMS reminders');
  }
  const updated: NotificationPreferences = {
    ...prefs,
    weeklyDigest: prefs.weeklyDigest ?? existing.weeklyDigest,
    phoneVerified,
    timezone,
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

// ---------------------------------------------------------------------------
// Phone verification (closes the long-standing docs/notifications.md TODO:
// previously any number could be entered and SMS enabled unverified).
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{6,14}$/;
const VERIFY_CODE_TTL_MS = 10 * 60 * 1000; // code is valid for 10 minutes
// DDB TTL sweeps the row a comfortable margin after expiry.
const VERIFY_ROW_TTL_SECONDS = 60 * 60;
const MAX_VERIFY_ATTEMPTS = 5;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Start verifying a phone number: store SHA-256(code) + expiry + attempt
 * counter on `USER#{id} / PHONE_VERIFY` (overwriting any previous attempt —
 * requesting a new code invalidates the old one), then text the code via SNS.
 * When SMS is disabled (`SMS_NOTIFICATIONS_ENABLED` ≠ 1) `sendSms` dry-run
 * logs the message, so the flow is exercisable in dev without spending money.
 */
export async function startPhoneVerification(
  userId: string,
  phone: string,
  now: Date = new Date()
): Promise<void> {
  if (!E164.test(phone)) {
    throw createHttpError(400, 'Phone must be in E.164 format, e.g. +15551234567');
  }
  // crypto.randomInt is uniform and CSPRNG-backed — never Math.random for codes.
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${userId}`,
        SK: 'PHONE_VERIFY',
        entityType: 'PhoneVerification',
        phone,
        codeHash: hashCode(code),
        expiresAt: new Date(now.getTime() + VERIFY_CODE_TTL_MS).toISOString(),
        attempts: 0,
        createdAt: now.toISOString(),
        ttl: Math.floor(now.getTime() / 1000) + VERIFY_ROW_TTL_SECONDS,
      },
    })
  );
  await smsNotifier.sendSms({
    to: phone,
    text: `Family Greenhouse verification code: ${code}. It expires in 10 minutes.`,
  });
  logger.info({ userId, msg: 'phone_verification_started' }, 'phone_verification_started');
}

/**
 * Confirm the 6-digit code. On success: stamps `phoneVerified: true` and the
 * verified number on the prefs row and deletes the verification row. Wrong
 * codes burn one of `MAX_VERIFY_ATTEMPTS` attempts (the counter lives in DDB,
 * so attempts can't be reset by hopping containers); comparison is
 * constant-time over the SHA-256 digests.
 */
export async function confirmPhoneVerification(
  userId: string,
  code: string,
  now: Date = new Date()
): Promise<NotificationPreferences> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: 'PHONE_VERIFY' },
    })
  );
  const item = result.Item;
  if (!item || (item.expiresAt as string) <= now.toISOString()) {
    throw createHttpError(400, 'Verification code expired or not found. Request a new code.');
  }
  if ((item.attempts as number) >= MAX_VERIFY_ATTEMPTS) {
    throw createHttpError(429, 'Too many incorrect attempts. Request a new code.');
  }
  const expected = Buffer.from(item.codeHash as string, 'hex');
  const actual = createHash('sha256').update(code).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    // Burn an attempt BEFORE reporting failure so a brute-forcer can't race.
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: 'PHONE_VERIFY' },
        UpdateExpression: 'SET attempts = attempts + :one',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':one': 1 },
      })
    );
    logger.info({ userId, msg: 'phone_verification_wrong_code' }, 'phone_verification_wrong_code');
    throw createHttpError(400, 'Incorrect verification code.');
  }

  const prefs = await getPreferences(userId);
  const updated: NotificationPreferences = {
    ...prefs,
    phone: item.phone as string,
    phoneVerified: true,
    updatedAt: now.toISOString(),
  };
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${userId}`,
        SK: 'PREFS',
        entityType: 'NotificationPreferences',
        ...updated,
      },
    })
  );
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: 'PHONE_VERIFY' },
    })
  );
  logger.info({ userId, msg: 'phone_verification_confirmed' }, 'phone_verification_confirmed');
  return updated;
}
