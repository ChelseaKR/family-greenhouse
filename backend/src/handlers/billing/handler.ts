import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import Stripe from 'stripe';
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
import { successResponse, cacheableResponse } from '../../utils/response.js';

const checkoutSchema = z.object({
  planId: z.enum(['garden', 'greenhouse']),
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
export const getCurrentSubscription = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const sub = await billing.getHouseholdSubscription(user.householdId!);
    return successResponse(sub);
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
        successUrl: `${baseUrl}/settings/billing?status=success`,
        cancelUrl: `${baseUrl}/settings/billing?status=cancel`,
      });
      return successResponse(session);
    } catch (err) {
      throw createHttpError(502, `Stripe checkout failed: ${(err as Error).message}`);
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
      throw createHttpError(400, (err as Error).message);
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
    if (!secret) throw createHttpError(500, 'Webhook secret not configured');
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
      stripeEvent = billing.getStripe().webhooks.constructEvent(rawBody, signature, secret);
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
