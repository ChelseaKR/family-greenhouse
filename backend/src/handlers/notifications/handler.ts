import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  rejectApiKeyPrincipal,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { authRateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import * as pushSubscriptions from '../../services/pushSubscriptions.js';
import * as deviceTokens from '../../services/deviceTokens.js';
import * as notificationPrefs from '../../services/notificationPrefs.js';
import { remindHousehold } from '../../services/reminders.js';
import { digestHousehold, recapHousehold, defaultRecapYear } from '../../services/digest.js';
import { successResponse, noContentResponse } from '../../utils/response.js';

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(8),
    auth: z.string().min(8),
  }),
});

type SubscribeInput = z.infer<typeof subscribeSchema>;

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

type UnsubscribeInput = z.infer<typeof unsubscribeSchema>;

/** Native (Capacitor iOS/Android) push device tokens. APNs tokens are 64+ hex
 *  chars; FCM tokens are opaque strings up to a few hundred chars. */
const registerDeviceSchema = z.object({
  platform: z.enum(['ios', 'android']),
  token: z.string().min(16).max(4096),
});

type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

const unregisterDeviceSchema = z.object({
  token: z.string().min(16).max(4096),
});

type UnregisterDeviceInput = z.infer<typeof unregisterDeviceSchema>;

const TIME_HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

const prefsSchema = z.object({
  browser: z.boolean(),
  email: z.boolean(),
  sms: z.boolean(),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/u, 'Phone must be in E.164 format, e.g. +15551234567')
    .or(z.literal(''))
    .default(''),
  /** Optional do-not-disturb window: both empty or both filled. */
  dndStart: z.string().regex(TIME_HHMM).or(z.literal('')).default(''),
  dndEnd: z.string().regex(TIME_HHMM).or(z.literal('')).default(''),
  /** IANA timezone — defaults to UTC if the client doesn't provide one. */
  timezone: z.string().min(1).max(64).default('UTC'),
  /** Opt-in seasonal pest pressure alerts. Defaults false. */
  pestAlerts: z.boolean().default(false),
  /** Weekly "plants at risk" digest. Optional so older clients that don't
   *  send it keep the stored value (default-on when email is enabled). */
  weeklyDigest: z.boolean().optional(),
});

type PrefsInput = z.infer<typeof prefsSchema>;

const startVerificationSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/u, 'Phone must be in E.164 format, e.g. +15551234567'),
});

type StartVerificationInput = z.infer<typeof startVerificationSchema>;

const confirmVerificationSchema = z.object({
  code: z.string().regex(/^\d{6}$/u, 'Verification code is 6 digits'),
});

type ConfirmVerificationInput = z.infer<typeof confirmVerificationSchema>;

/** Optional body — `POST /notifications/run-year-recap` accepts `{year}` or
 *  no body at all (null/undefined normalize to an empty object). */
const recapSchema = z
  .object({ year: z.number().int().min(2000).max(2100).optional() })
  .nullish()
  .transform((v) => v ?? {});

type RecapInput = z.infer<typeof recapSchema>;

// GET /notifications/prefs
export const getPrefs = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const prefs = await notificationPrefs.getPreferences(user.userId);
    return successResponse(prefs);
  }
).use(authMiddleware());

// PUT /notifications/prefs
export const updatePrefs = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<PrefsInput>;
    if (validatedBody.sms && !validatedBody.phone) {
      throw createHttpError(400, 'A phone number is required to enable SMS reminders');
    }
    const updated = await notificationPrefs.setPreferences({
      userId: user.userId,
      browser: validatedBody.browser,
      email: validatedBody.email,
      sms: validatedBody.sms,
      phone: validatedBody.phone,
      dndStart: validatedBody.dndStart,
      dndEnd: validatedBody.dndEnd,
      timezone: validatedBody.timezone,
      pestAlerts: validatedBody.pestAlerts,
      weeklyDigest: validatedBody.weeklyDigest,
    });
    return successResponse(updated);
  }
)
  .use(authMiddleware())
  .use(validateBody(prefsSchema));

// POST /notifications/subscribe
export const subscribe = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<SubscribeInput>;
    if (!user.householdId) {
      throw createHttpError(403, 'User must belong to a household');
    }
    await pushSubscriptions.saveSubscription({
      userId: user.userId,
      householdId: user.householdId,
      endpoint: validatedBody.endpoint,
      keys: validatedBody.keys,
      createdAt: new Date().toISOString(),
    });
    return successResponse({ ok: true });
  }
)
  .use(authMiddleware())
  .use(validateBody(subscribeSchema));

/**
 * POST /notifications/devices — register a native (iOS/Android) push device
 * token from the Capacitor shells. Mirrors /notifications/subscribe for web
 * push. CAPTURE-ONLY until the APNs/FCM sender lands (docs/mobile.md): tokens
 * are stored so the sender covers existing installs the day it ships.
 */
// POST /notifications/devices
export const registerDevice = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<RegisterDeviceInput>;
    if (!user.householdId) {
      throw createHttpError(403, 'User must belong to a household');
    }
    await deviceTokens.saveDeviceToken({
      userId: user.userId,
      householdId: user.householdId,
      platform: validatedBody.platform,
      token: validatedBody.token,
      createdAt: new Date().toISOString(),
    });
    return successResponse({ ok: true });
  }
)
  .use(authMiddleware())
  .use(validateBody(registerDeviceSchema));

// POST /notifications/devices/remove
export const unregisterDevice = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<UnregisterDeviceInput>;
    await deviceTokens.deleteDeviceToken(user.userId, validatedBody.token);
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(validateBody(unregisterDeviceSchema));

// POST /notifications/unsubscribe
export const unsubscribe = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<UnsubscribeInput>;
    await pushSubscriptions.deleteSubscription(user.userId, validatedBody.endpoint);
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(validateBody(unsubscribeSchema));

/**
 * POST /notifications/run-reminders
 *
 * Walks through every member of the caller's household, finds their assigned
 * tasks (or all tasks for admins) due in the next 24 hours plus anything
 * already overdue, and sends a single roll-up push per user.
 *
 * In production, EventBridge invokes this hourly with an internal IAM
 * principal; while we don't have that wired up yet, the endpoint also accepts
 * an authenticated household admin so families can self-service "send
 * reminders now" if needed.
 */
// POST /notifications/run-reminders
export const runReminders = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    if (user.householdRole !== 'admin') {
      throw createHttpError(403, 'Admin access required');
    }
    // Shared with the hourly EventBridge scan (handlers/reminders/handler.ts).
    const sent = await remindHousehold(user.householdId!);
    return successResponse({ sent });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  // Internal cron / break-glass route: never a machine key (defense-in-depth
  // even though API keys don't reach this handler today). See M2.
  .use(rejectApiKeyPrincipal())
  // Fans out push/email/SMS to the whole household — each call costs real
  // money on the paid notification channels. "Send reminders now" is a
  // break-glass button, not a polling target: 2/hour per admin.
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 2 }));

/**
 * POST /notifications/run-digests
 *
 * Manual trigger for the weekly "plants at risk" digest, scoped to the
 * caller's household (the weekly EventBridge scan in handlers/digests covers
 * everyone). Admin-only and tightly rate limited, mirroring run-reminders.
 * The per-user weekly dedupe marker still applies, so re-triggering inside
 * the same ISO week is a no-op.
 */
// POST /notifications/run-digests
export const runDigests = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    if (user.householdRole !== 'admin') {
      throw createHttpError(403, 'Admin access required');
    }
    const sent = await digestHousehold(user.householdId!);
    return successResponse({ sent });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(rejectApiKeyPrincipal())
  // Same budget rationale as run-reminders: email costs money per send.
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 2 }));

/**
 * POST /notifications/run-year-recap
 *
 * Manual trigger for the end-of-year recap, scoped to the caller's household.
 * Accepts an optional `{year}`; defaults to the previous calendar year (the
 * same default the yearly EventBridge run uses). The per-household yearly
 * marker makes retries a no-op.
 */
// POST /notifications/run-year-recap
export const runYearRecap = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<RecapInput>;
    if (user.householdRole !== 'admin') {
      throw createHttpError(403, 'Admin access required');
    }
    const year = validatedBody.year ?? defaultRecapYear();
    const sent = await recapHousehold(user.householdId!, year);
    return successResponse({ sent, year });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(rejectApiKeyPrincipal())
  .use(validateBody(recapSchema))
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 2 }));

/**
 * POST /notifications/phone/start-verification
 *
 * Sends a 6-digit code to the submitted E.164 number. Each request costs an
 * SMS, and unthrottled it would let an attacker spray texts at arbitrary
 * numbers from our SNS origination identity — hence the IP limiter PLUS a
 * tight 3/hour per-user budget.
 */
// POST /notifications/phone/start-verification
export const startPhoneVerification = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<StartVerificationInput>;
    await notificationPrefs.startPhoneVerification(user.userId, validatedBody.phone);
    return successResponse({ sent: true });
  }
)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(startVerificationSchema))
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 3 }));

/**
 * POST /notifications/phone/confirm-verification
 *
 * Confirms the code; on success stamps `phoneVerified` + the verified number
 * on the prefs row and returns the updated prefs. Wrong codes burn one of 5
 * attempts (tracked in DDB, not per-container memory). The route limiter is
 * defence-in-depth on top of that counter.
 */
// POST /notifications/phone/confirm-verification
export const confirmPhoneVerification = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<ConfirmVerificationInput>;
    const updated = await notificationPrefs.confirmPhoneVerification(
      user.userId,
      validatedBody.code
    );
    return successResponse(updated);
  }
)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(confirmVerificationSchema))
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 10 }));

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /notifications/prefs': getPrefs,
  'PUT /notifications/prefs': updatePrefs,
  'POST /notifications/subscribe': subscribe,
  'POST /notifications/unsubscribe': unsubscribe,
  'POST /notifications/devices': registerDevice,
  'POST /notifications/devices/remove': unregisterDevice,
  'POST /notifications/run-reminders': runReminders,
  'POST /notifications/run-digests': runDigests,
  'POST /notifications/run-year-recap': runYearRecap,
  'POST /notifications/phone/start-verification': startPhoneVerification,
  'POST /notifications/phone/confirm-verification': confirmPhoneVerification,
});
