import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import * as pushSubscriptions from '../../services/pushSubscriptions.js';
import * as notificationPrefs from '../../services/notificationPrefs.js';
import { remindHousehold } from '../../services/reminders.js';
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
});

type PrefsInput = z.infer<typeof prefsSchema>;

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
  .use(requireHousehold());

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /notifications/prefs': getPrefs,
  'PUT /notifications/prefs': updatePrefs,
  'POST /notifications/subscribe': subscribe,
  'POST /notifications/unsubscribe': unsubscribe,
  'POST /notifications/run-reminders': runReminders,
});
