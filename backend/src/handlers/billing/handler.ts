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
import { getCreditBalance } from '../../services/identifyCredits.js';
import {
  createIdentifyTopUpCheckoutSession,
  TOP_UP_NOT_CONFIGURED,
} from '../../services/identifyTopUp.js';
import { getPlan, isIntervalOffered } from '../../models/plans.js';
import { identifyTopUpSummary, isIdentifyTopUpConfigured } from '../../models/identifyTopUp.js';
import { successResponse, cacheableResponse } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';
import {
  COMMERCIAL_HOLD_ACTIVE,
  COMMERCIAL_HOLD_EFFECTIVE_DATE,
  paymentsAreAvailable,
  isPaymentActivityDisabledError,
} from '../../config/commercialStatus.js';

const checkoutSchema = z
  .object({
    planId: z.enum(['garden', 'greenhouse']),
    // Billing cadence. Optional + defaulted so existing clients that send only
    // `planId` keep getting a monthly subscription unchanged. `lifetime` is a
    // one-time payment offered on Garden only (enforced by the refine below).
    interval: z.enum(['month', 'year', 'lifetime']).optional().default('month'),
    // Generated once per checkout click and forwarded to Stripe. Optional for
    // backwards compatibility with older clients.
    checkoutAttemptId: z.string().uuid().optional(),
  })
  .refine((v) => v.interval !== 'lifetime' || v.planId === 'garden', {
    message: 'The lifetime plan is only available for the Garden tier.',
    path: ['interval'],
  })
  // Withdrawn cadences. The plan catalog is the single authority on what may
  // be STARTED today (`withdrawnIntervals` in models/plans.ts): a cadence can
  // exist for households already on it and still be refused here. The same
  // rule publishes as a null price in GET /billing/plans, so a current client
  // never shows the option, and a stale or crafted request gets a clear 400
  // rather than a Stripe session for something we no longer sell.
  .refine((v) => isIntervalOffered(getPlan(v.planId), v.interval), {
    message: 'That billing option is no longer offered. Existing subscriptions are unaffected.',
    path: ['interval'],
  });

type CheckoutInput = z.infer<typeof checkoutSchema>;

// Body of POST /billing/top-up/checkout. There is exactly one pack, so the
// body carries nothing but the per-click idempotency key; `{}` and a missing
// body are both fine.
const topUpCheckoutSchema = z
  .object({
    checkoutAttemptId: z.string().uuid().optional(),
  })
  .nullable()
  .transform((v) => v ?? {});

type TopUpCheckoutInput = z.infer<typeof topUpCheckoutSchema>;

// GET /billing/plans  (public, no auth)
// Plans rarely change. Cacheable publicly for 5 minutes — long enough that
// CloudFront absorbs landing-page traffic, short enough that a price-change
// deploy is reflected without a cache bust.
export const listPlans = createHandler((): Promise<APIGatewayProxyResult> => {
  const paymentsAvailable = paymentsAreAvailable();
  return Promise.resolve(
    cacheableResponse(
      {
        paymentsAvailable,
        commercialHold: {
          active: COMMERCIAL_HOLD_ACTIVE,
          effectiveDate: COMMERCIAL_HOLD_EFFECTIVE_DATE,
        },
        plans: ALL_PLANS.map((plan) => billing.planSummary(plan, paymentsAvailable)),
        // The identification top-up offer, on the same fail-closed terms as
        // the plan prices: `available` is true only when payments are on AND
        // a Stripe price is configured; the amount appears only when
        // payments are on.
        identifyTopUp: identifyTopUpSummary(paymentsAvailable),
      },
      {
        maxAgeSeconds: 300,
        visibility: 'public',
      }
    )
  );
});

// GET /billing/me
// Returns the subscription plus current usage against the plan's caps so the
// UI can render meters and an over-limit notice after a downgrade. The legacy
// `usage` object remains numeric-only for rolling-deploy/PWA compatibility and
// is omitted if either counter is unknown. `usageDetail` is the additive,
// nullable source of truth for current clients.
export const getCurrentSubscription = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const [sub, counters, identifyCredits] = await Promise.all([
      billing.getHouseholdSubscription(user.householdId!),
      getHouseholdCounters(user.householdId!),
      // Top-up credit balance. `null` = the read failed and the balance is
      // unknown; a real 0 is `{ remaining: 0, expiresAt: null }`.
      getCreditBalance(user.householdId!),
    ]);
    const plan = getPlan(sub.planId);
    const usageDetail = {
      plantCount: counters.plantCount,
      maxPlants: plan.maxPlants,
      memberCount: counters.memberCount,
      maxMembers: plan.maxMembers,
    };
    const usage =
      counters.plantCount !== null && counters.memberCount !== null
        ? {
            plantCount: counters.plantCount,
            maxPlants: plan.maxPlants,
            memberCount: counters.memberCount,
            maxMembers: plan.maxMembers,
          }
        : undefined;
    return successResponse({
      ...sub,
      ...(usage ? { usage } : {}),
      usageDetail,
      identifyCredits,
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
        idempotencyKey: validatedBody.checkoutAttemptId
          ? `checkout:${user.householdId}:${validatedBody.checkoutAttemptId}`
          : undefined,
      });
      return successResponse(session);
    } catch (err) {
      // Client-correctable: the cadence has been withdrawn from sale. The
      // schema above refuses a well-formed request first; this maps the
      // service-level guard for any path that reaches it around the schema.
      if ((err as Error).message?.startsWith('INTERVAL_WITHDRAWN')) {
        throw createHttpError(
          400,
          'That billing option is no longer offered. Existing subscriptions are unaffected.',
          { expose: true }
        );
      }
      // Client-correctable: the household already owns this tier outright.
      // A 502 here would read as "our payment provider broke" for what is
      // actually a correct refusal to sell the same thing twice.
      if ((err as Error).message?.startsWith('LIFETIME_ALREADY_OWNED')) {
        throw createHttpError(
          409,
          'Your household already owns this plan permanently. There is nothing more to buy at this tier.',
          { expose: true }
        );
      }
      // Client-correctable: already has a live subscription. Map to a clear
      // 409 pointing at the portal, rather than the generic Stripe-failure
      // 502 below (see createCheckoutSession's ALREADY_SUBSCRIBED guard).
      if ((err as Error).message?.startsWith('ALREADY_SUBSCRIBED')) {
        throw createHttpError(
          409,
          'Your household already has an active subscription. Use "Manage subscription" to change plans.'
        );
      }
      if (isPaymentActivityDisabledError(err)) {
        throw createHttpError(503, 'Payments are currently paused.', { expose: true });
      }
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

// POST /billing/top-up/checkout
//
// One-time Stripe Checkout for an identification top-up pack
// (models/identifyTopUp.ts). Admin-only like every other purchase. Fails
// CLOSED on configuration: with no price id in the environment the answer
// is a 400 carrying `code: TOP_UP_NOT_CONFIGURED`, before Stripe is touched
// — never a fallback price, never a free credit.
export const topUpCheckout = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<TopUpCheckoutInput>;
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const notConfigured = () =>
      createHttpError(400, 'Identification top-up packs are not available in this environment.', {
        expose: true,
        details: { code: TOP_UP_NOT_CONFIGURED },
      });
    // Refuse before the service so a misconfigured environment cannot reach
    // DynamoDB or Stripe for a product it does not sell. The service checks
    // again (after the payments gate) for any path around this handler.
    if (!isIdentifyTopUpConfigured()) throw notConfigured();
    try {
      const session = await createIdentifyTopUpCheckoutSession({
        householdId: user.householdId!,
        customerEmail: user.email,
        successUrl: `${baseUrl}/settings/billing?status=success&purchase=identify-top-up`,
        cancelUrl: `${baseUrl}/settings/billing?status=cancel`,
        idempotencyKey: validatedBody.checkoutAttemptId
          ? `top-up:${user.householdId}:${validatedBody.checkoutAttemptId}`
          : undefined,
      });
      return successResponse(session);
    } catch (err) {
      if (isPaymentActivityDisabledError(err)) {
        throw createHttpError(503, 'Payments are currently paused.', { expose: true });
      }
      if ((err as Error).message?.startsWith(TOP_UP_NOT_CONFIGURED)) throw notConfigured();
      logger.error({ err }, 'stripe_top_up_checkout_failed');
      throw createHttpError(502, 'Stripe checkout failed. Please try again shortly.', {
        expose: true,
      });
    }
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(topUpCheckoutSchema));

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
      if (isPaymentActivityDisabledError(err)) {
        throw createHttpError(503, 'Billing access is currently paused.', { expose: true });
      }
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
  'POST /billing/top-up/checkout': topUpCheckout,
  'POST /billing/portal': portal,
  'POST /billing/webhook': webhook,
});
