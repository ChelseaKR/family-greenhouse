import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
// Type-only: the runtime SDK is lazily loaded via billing.getStripe() so the
// webhook bundle doesn't evaluate Stripe at cold start.
import type Stripe from 'stripe';
import { createHandler, createRawBodyHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  requireAdmin,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import * as billing from '../../services/billing.js';
import { ALL_PLANS } from '../../services/billing.js';
import { getHouseholdCounters } from '../../services/householdUsage.js';
import { getPlan } from '../../models/plans.js';
import { successResponse, cacheableResponse } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';

const checkoutSchema = z
  .object({
    planId: z.enum(['garden', 'greenhouse']),
    // Billing cadence. Optional + defaulted so existing clients that send only
    // `planId` keep getting a monthly subscription unchanged. `lifetime` is a
    // one-time payment offered on Garden only (enforced by the refine below).
    interval: z.enum(['month', 'year', 'lifetime']).optional().default('month'),
  })
  .refine((v) => v.interval !== 'lifetime' || v.planId === 'garden', {
    message: 'The lifetime plan is only available for the Garden tier.',
    path: ['interval'],
  });

type CheckoutInput = z.infer<typeof checkoutSchema>;

// GET /billing/plans  (public, no auth)
// Plans rarely change. Cacheable publicly for 5 minutes — long enough that
// CloudFront absorbs landing-page traffic, short enough that a price-change
// deploy is reflected without a cache bust.
export const listPlans = createHandler((): Promise<APIGatewayProxyResult> => {
  return Promise.resolve(
    cacheableResponse(ALL_PLANS.map(billing.planSummary), {
      maxAgeSeconds: 300,
      visibility: 'public',
    })
  );
});

// GET /billing/me
// Returns the subscription plus current usage against the plan's caps
// ({plantCount, maxPlants, memberCount, maxMembers}) so the UI can render
// usage meters and an over-limit notice after a downgrade. Counters missing
// from legacy METADATA rows read as 0 (see services/householdUsage.ts).
export const getCurrentSubscription = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const [sub, counters] = await Promise.all([
      billing.getHouseholdSubscription(user.householdId!),
      getHouseholdCounters(user.householdId!),
    ]);
    const plan = getPlan(sub.planId);
    return successResponse({
      ...sub,
      usage: {
        plantCount: counters.plantCount,
        maxPlants: plan.maxPlants,
        memberCount: counters.memberCount,
        maxMembers: plan.maxMembers,
      },
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /billing/checkout
export const checkout = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CheckoutInput>;
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    try {
      const session = await billing.createCheckoutSession({
        householdId: user.householdId!,
        customerEmail: user.email,
        planId: validatedBody.planId,
        interval: validatedBody.interval,
        successUrl: `${baseUrl}/settings/billing?status=success`,
        cancelUrl: `${baseUrl}/settings/billing?status=cancel`,
      });
      return successResponse(session);
    } catch (err) {
      // Don't echo the raw Stripe SDK error to clients — log it, return a
      // safe upstream-failure message. `expose: true` marks this 502 as
      // intentional so the JSON error handler keeps the message.
      logger.error({ err }, 'stripe_checkout_failed');
      throw createHttpError(502, 'Stripe checkout failed. Please try again shortly.', {
        expose: true,
      });
    }
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(checkoutSchema));

// POST /billing/portal
export const portal = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    try {
      const result = await billing.createPortalSession(
        user.householdId!,
        `${baseUrl}/settings/billing`
      );
      return successResponse(result);
    } catch (err) {
      // The only client-correctable failure is "household has never checked
      // out" — map that to a friendly 400. Everything else is an upstream
      // Stripe problem: log the raw error, return a safe 502 (never echo the
      // SDK message to clients).
      if ((err as Error).message?.includes('No Stripe customer on file')) {
        throw createHttpError(
          400,
          'No Stripe customer on file for this household. Subscribe to a plan first.'
        );
      }
      logger.error({ err }, 'stripe_portal_failed');
      throw createHttpError(502, 'Billing portal is temporarily unavailable.', { expose: true });
    }
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

/**
 * POST /billing/webhook
 *
 * Stripe webhook receiver. Note that the body parser middleware is bypassed
 * because Stripe wants the raw body for signature verification — we install
 * this handler at the API Gateway with `bodyHandling: 'raw'` and use
 * `event.body` directly.
 */
// POST /billing/webhook
export const webhook = createRawBodyHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    // expose: true — this 500 is an intentional, safe operator-facing
    // message that should reach the Stripe dashboard's delivery log.
    if (!secret) throw createHttpError(500, 'Webhook secret not configured', { expose: true });
    if (!signature || typeof signature !== 'string') {
      throw createHttpError(400, 'Missing Stripe signature');
    }
    // event.body MUST be a string at this point (we opted out of the JSON
    // body parser via createRawBodyHandler). API Gateway forwards Stripe's
    // raw payload, including any base64-encoded transport from the legacy
    // REST API path. If it ever arrives as an object, the bundle's middleware
    // stack is misconfigured — bail loudly rather than silently re-serializing.
    if (typeof event.body !== 'string') {
      throw createHttpError(
        500,
        'Webhook handler received parsed body — body parser must be skipped'
      );
    }
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    let stripeEvent: Stripe.Event;
    try {
      const stripe = await billing.getStripe();
      stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      throw createHttpError(400, `Webhook signature failed: ${(err as Error).message}`);
    }
    await billing.applyStripeEvent(stripeEvent);
    return successResponse({ received: true });
  }
);

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /billing/plans': listPlans,
  'GET /billing/me': getCurrentSubscription,
  'POST /billing/checkout': checkout,
  'POST /billing/portal': portal,
  'POST /billing/webhook': webhook,
});
