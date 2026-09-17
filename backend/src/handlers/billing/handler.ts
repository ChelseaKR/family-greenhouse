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
  IDENTIFICATION_NOT_CONFIGURED,
  TOP_UP_NOT_CONFIGURED,
} from '../../services/identifyTopUp.js';
import { isPlantIdentificationConfigured } from '../../services/plantIdentification.js';
import {
  createGiftCheckoutSession,
  GIFT_MONTHS_INVALID,
  GIFT_NOT_CONFIGURED,
  isGiftRedeemError,
  redeemGiftCode,
  type GiftRedeemErrorCode,
} from '../../services/giftSubscriptions.js';
import { listGiftPurchases } from '../../services/giftCodes.js';
import {
  getEntitledPlan,
  getPlan,
  giftState,
  isIntervalOffered,
  limitOf,
  noCardTrialState,
} from '../../models/plans.js';
import { identifyTopUpSummary, isIdentifyTopUpConfigured } from '../../models/identifyTopUp.js';
import {
  GIFT_MAX_MONTHS,
  GIFT_MIN_MONTHS,
  giftSubscriptionSummary,
  isGiftConfigured,
} from '../../models/giftSubscriptions.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
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

/**
 * `details.code` on the 409 for a plan checkout refused because one this
 * household was already handed is still unreported by Stripe. Same shape as
 * `TOP_UP_NOT_CONFIGURED`: a stable token the client branches on, beside a
 * message it may show verbatim.
 */
export const CHECKOUT_PENDING = 'CHECKOUT_PENDING';

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

// Body of POST /billing/gift/checkout (ADR 0028): which tier, for how many
// months. The months bound is the catalog's, so the schema and the service
// refuse the same range.
const giftCheckoutSchema = z.object({
  planId: z.enum(['garden', 'greenhouse']),
  months: z.number().int().min(GIFT_MIN_MONTHS).max(GIFT_MAX_MONTHS),
  checkoutAttemptId: z.string().uuid().optional(),
});

type GiftCheckoutInput = z.infer<typeof giftCheckoutSchema>;

// Body of POST /billing/gift/redeem. The code is normalised by the service
// (case, spaces, dashes); the schema only bounds what reaches it.
const giftRedeemSchema = z.object({
  code: z.string().min(1).max(64),
});

type GiftRedeemInput = z.infer<typeof giftRedeemSchema>;

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
        // the plan prices: `available` is true only when payments are on, a
        // Stripe price is configured, AND this process holds the vendor key
        // the credits would be spent against; the amount appears only when
        // payments are on.
        identifyTopUp: identifyTopUpSummary(paymentsAvailable, isPlantIdentificationConfigured()),
        // Gift subscriptions (ADR 0028), on the same terms. The per-month
        // amount is the tier's monthlyPrice above; this says only which tiers
        // can be given here and for how long.
        giftSubscriptions: giftSubscriptionSummary(paymentsAvailable),
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
    // The meters must show the caps that are actually ENFORCED. Resolving
    // them off planId alone would advertise Garden's plant cap to a past_due
    // household whose next POST /plants is refused at Seedling's. `planId`
    // itself stays truthful: it is the plan they are on, which is not the
    // same as the caps they may currently use.
    const now = new Date();
    const plan = getEntitledPlan(sub, now);
    const usageDetail = {
      plantCount: counters.plantCount,
      maxPlants: limitOf(plan, 'plants'),
      memberCount: counters.memberCount,
      maxMembers: limitOf(plan, 'members'),
    };
    const usage =
      counters.plantCount !== null && counters.memberCount !== null
        ? {
            plantCount: counters.plantCount,
            maxPlants: limitOf(plan, 'plants'),
            memberCount: counters.memberCount,
            maxMembers: limitOf(plan, 'members'),
          }
        : undefined;
    // The no-card trial goes out as what the SERVER's clock says about it
    // (ADR 0027): its state and its end date, never the raw row attribute. A
    // client with a wrong clock can change how many days it counts down, never
    // whether the household is on the trial. `null` means there is no no-card
    // trial to describe: the household never had one, or Stripe owns its
    // entitlement.
    const { noCardTrialEndsAt, giftPlanId, giftEndsAt, giftSource, ...published } = sub;
    const trialState = noCardTrialState(sub, now);
    // A redeemed gift (ADR 0028) goes out the same way: the server's clock
    // decides its state. `null` means there is no gift to describe.
    const giftNow = giftState(sub, now);
    return successResponse({
      ...published,
      ...(usage ? { usage } : {}),
      usageDetail,
      identifyCredits,
      noCardTrial:
        trialState === 'none' || !noCardTrialEndsAt
          ? null
          : { state: trialState, endsAt: noCardTrialEndsAt },
      gift:
        giftNow === 'none' || !giftPlanId || !giftEndsAt
          ? null
          : {
              planId: giftPlanId,
              endsAt: giftEndsAt,
              state: giftNow,
              // Absent on a gift redeemed before ADR 0029 (or on a fresh
              // read where giftCodes.redeemGift's write predates this field)
              // means 'purchase' — see the doc comment on HouseholdSubscription.
              source: giftSource ?? 'purchase',
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
      // Not client-correctable right now, and the one refusal a buyer who
      // has just PAID can hit: a plan checkout this household was handed is
      // still unreported by Stripe. The code lets the client say "in
      // progress" rather than "already subscribed" (the row does not say
      // that yet) or "provider failed" (nothing failed). The window is the
      // service's, so the message quotes it rather than restating it.
      if ((err as Error).message?.startsWith('CHECKOUT_PENDING')) {
        const minutes = Math.ceil(billing.PENDING_CHECKOUT_WINDOW_MS / 60_000);
        throw createHttpError(
          409,
          `A checkout for this household is already in progress. If you just paid, your plan updates as soon as our payment provider confirms it — do not check out again. An unfinished checkout releases on its own within ${minutes} minutes.`,
          { expose: true, details: { code: CHECKOUT_PENDING } }
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
    // Priced and payable is not sellable: the pack buys identifications, and
    // without the vendor key none can be made. A distinct code, because the
    // client must say which promise it cannot keep, and a 400 like the price
    // case — this is the environment's state, not the buyer's mistake and
    // not a provider failure.
    const identificationNotConfigured = () =>
      createHttpError(
        400,
        'Plant identification is not set up in this environment, so identification packs are not for sale.',
        { expose: true, details: { code: IDENTIFICATION_NOT_CONFIGURED } }
      );
    if (!isPlantIdentificationConfigured()) throw identificationNotConfigured();
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
      if ((err as Error).message?.startsWith(IDENTIFICATION_NOT_CONFIGURED)) {
        throw identificationNotConfigured();
      }
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

// POST /billing/gift/checkout
//
// One-time Stripe Checkout for a gift subscription (models/giftSubscriptions.ts,
// ADR 0028): N months of a paid tier for somebody else. Any signed-in user
// may buy one — it charges the buyer's own card, names no household on the
// Session (see createGiftCheckoutSession), and changes nothing about the
// buyer's own household, if they even have one. That is also why this route
// carries no `requireHousehold`, unlike every other purchase route: a buyer
// giving a gift to a friend has no reason to have created a household of
// their own first, and the service call below never reads one. Also without
// `requireAdmin`, for the same reason. Fails CLOSED on configuration exactly
// like the top-up.
export const giftCheckout = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<GiftCheckoutInput>;
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    // A household member returns to the billing settings they already know;
    // a buyer with no household (the public /gift page is the only way to
    // reach one) returns to /gift, which reads its own purchase list — the
    // /settings/billing route lives behind ProtectedRoute's household gate
    // and would otherwise bounce a gift-only buyer into onboarding right
    // after they paid.
    const returnPath = user.householdId ? '/settings/billing' : '/gift';
    const notConfigured = () =>
      createHttpError(400, 'Gift subscriptions are not available in this environment.', {
        expose: true,
        details: { code: GIFT_NOT_CONFIGURED },
      });
    if (!isGiftConfigured(validatedBody.planId)) throw notConfigured();
    try {
      const session = await createGiftCheckoutSession({
        buyerUserId: user.userId,
        buyerEmail: user.email,
        planId: validatedBody.planId,
        months: validatedBody.months,
        successUrl: `${baseUrl}${returnPath}?status=success&purchase=gift`,
        cancelUrl: `${baseUrl}${returnPath}?status=cancel`,
        idempotencyKey: validatedBody.checkoutAttemptId
          ? `gift:${user.userId}:${validatedBody.checkoutAttemptId}`
          : undefined,
      });
      return successResponse(session);
    } catch (err) {
      if (isPaymentActivityDisabledError(err)) {
        throw createHttpError(503, 'Payments are currently paused.', { expose: true });
      }
      if ((err as Error).message?.startsWith(GIFT_NOT_CONFIGURED)) throw notConfigured();
      if ((err as Error).message?.startsWith(GIFT_MONTHS_INVALID)) {
        throw createHttpError(400, 'A gift is between 1 and 12 months.', {
          expose: true,
          details: { code: GIFT_MONTHS_INVALID },
        });
      }
      logger.error({ err }, 'stripe_gift_checkout_failed');
      throw createHttpError(502, 'Stripe checkout failed. Please try again shortly.', {
        expose: true,
      });
    }
  }
)
  .use(authMiddleware())
  .use(userRateLimit({ perWindowMs: 60_000, max: 10 }))
  .use(validateBody(giftCheckoutSchema));

/**
 * HTTP status for each redemption refusal. 400s are things about the code
 * itself; 409s are things about the household, which a different household
 * (or the same one, later) would not hit. None consume the code.
 */
const GIFT_REDEEM_STATUS: Record<GiftRedeemErrorCode, number> = {
  GIFT_CODE_INVALID: 400,
  GIFT_CODE_EXPIRED: 400,
  GIFT_CODE_REDEEMED: 409,
  GIFT_HOUSEHOLD_SUBSCRIBED: 409,
  GIFT_ALREADY_ACTIVE: 409,
  GIFT_ADDS_NOTHING: 409,
  GIFT_REDEEM_CONFLICT: 409,
};

// POST /billing/gift/redeem
//
// Places a gift on the caller's household (ADR 0028). Admin-only: it changes
// the household's plan, which is the admin's call everywhere else. The code
// is a bearer credential, so the route is rate-limited by IP (before auth
// would be better, but the limiter needs the route; it runs first in the
// chain) and per user, and the body is never logged.
export const giftRedeem = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<GiftRedeemInput>;
    try {
      const redemption = await redeemGiftCode({
        code: validatedBody.code,
        householdId: user.householdId!,
      });
      return successResponse(redemption);
    } catch (err) {
      if (isGiftRedeemError(err)) {
        throw createHttpError(
          GIFT_REDEEM_STATUS[err.code],
          'This gift code could not be redeemed.',
          {
            expose: true,
            details: { code: err.code, ...err.details },
          }
        );
      }
      logger.error({ err: (err as Error).message }, 'gift_redeem_failed');
      throw createHttpError(502, 'The gift could not be redeemed right now. Please try again.', {
        expose: true,
      });
    }
  }
)
  .use(rateLimit({ perWindowMs: 60_000, max: 5 }))
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 20 }))
  .use(validateBody(giftRedeemSchema));

// GET /billing/gift/purchases
//
// The gifts this account has bought, with their codes and whether each has
// been redeemed. The buyer's own rows only, keyed by userId — no household
// gate here either, the same reasoning as POST /billing/gift/checkout: a
// gift-only buyer with no household still needs to read the codes they paid
// for, and the read never touches a household record. A failed read is a
// 502, never an empty list.
export const giftPurchases = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    try {
      const purchases = await listGiftPurchases(user.userId);
      return successResponse({ purchases });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'gift_purchases_read_failed');
      throw createHttpError(502, 'Your gifts could not be read right now. Please try again.', {
        expose: true,
      });
    }
  }
).use(authMiddleware());

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
  'POST /billing/gift/checkout': giftCheckout,
  'POST /billing/gift/redeem': giftRedeem,
  'GET /billing/gift/purchases': giftPurchases,
  'POST /billing/portal': portal,
  'POST /billing/webhook': webhook,
});
