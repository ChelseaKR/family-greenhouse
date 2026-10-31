import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireAdmin,
  requireHousehold,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import { successResponse } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';
import { appStoreBillingEnabled } from '../../config/appStore.js';
import { appStoreProductForPlan } from '../../models/appStore.js';
import { getEntitledPlan } from '../../models/plans.js';
import { getHouseholdSubscription } from '../../services/billing.js';
import {
  applyConsentNotification,
  applyNotification,
  applyVerifiedTransaction,
  getOrCreateAccountToken,
  purchaseRefusal,
  verifyRenewalInfo,
  verifyTransaction,
  type ApplyOutcome,
} from '../../services/appStoreBilling.js';
import { AppStoreVerificationError } from '../../services/appStoreJws.js';

/**
 * Apple In-App Purchase routes (ADR 0041). All three answer 404 while the
 * switch is off (config/appStore.ts), so a build of the app that asks early
 * learns only that the feature is not there.
 */
function assertEnabled(): void {
  if (!appStoreBillingEnabled()) throw createHttpError(404, 'Not found');
}

/** `details.code` values a client branches on. */
export const APP_STORE_CODES = {
  STRIPE_SUBSCRIPTION_ACTIVE: 'STRIPE_SUBSCRIPTION_ACTIVE',
  APP_STORE_SUBSCRIPTION_ACTIVE: 'APP_STORE_SUBSCRIPTION_ACTIVE',
  PLAN_ALREADY_INCLUDED: 'PLAN_ALREADY_INCLUDED',
  LINKED_ELSEWHERE: 'APP_STORE_LINKED_ELSEWHERE',
  OTHER_SUBSCRIPTION: 'APP_STORE_OTHER_SUBSCRIPTION',
} as const;

const REFUSAL_MESSAGES: Record<string, string> = {
  // Neutral on purpose: the app shows these, and inside the app nothing may
  // point at another way to pay (App Review Guideline 3.1.1).
  STRIPE_SUBSCRIPTION_ACTIVE: 'This household already has a paid plan.',
  APP_STORE_SUBSCRIPTION_ACTIVE:
    'This household already has an App Store subscription. Change it from Manage subscription.',
  PLAN_ALREADY_INCLUDED: 'This household already has this plan.',
};

const purchaseSchema = z.object({ planId: z.enum(['garden', 'greenhouse']) });
type PurchaseInput = z.infer<typeof purchaseSchema>;

// POST /billing/app-store/purchase-intent
//
// Before the app opens Apple's purchase sheet: refuses a second way of paying
// for the same home, and hands back the product id and the household's
// appAccountToken for StoreKit to stamp into the transaction. Admin-only like
// every other purchase.
export const purchaseIntent = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    assertEnabled();
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<PurchaseInput>;
    const householdId = user.householdId!;
    const refusal = await purchaseRefusal(householdId, validatedBody.planId);
    if (refusal) {
      throw createHttpError(409, REFUSAL_MESSAGES[refusal], {
        expose: true,
        details: { code: refusal },
      });
    }
    const productId = appStoreProductForPlan(validatedBody.planId);
    if (!productId) throw createHttpError(400, 'Unknown plan');
    const appAccountToken = await getOrCreateAccountToken(householdId);
    return successResponse({ productId, appAccountToken });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(userRateLimit({ perWindowMs: 60_000, max: 20 }))
  .use(validateBody(purchaseSchema));

const transactionsSchema = z.object({
  // StoreKit's `jwsRepresentation` for each transaction: one after a
  // purchase, the current entitlements after a restore or at launch.
  signedTransactions: z.array(z.string().min(1).max(16_000)).min(1).max(10),
  // `Product.SubscriptionInfo.RenewalInfo`'s jwsRepresentation, when the app
  // has it, so a billing grace period counts from the first post.
  signedRenewalInfos: z.array(z.string().min(1).max(16_000)).max(10).optional(),
});
type TransactionsInput = z.infer<typeof transactionsSchema>;

const OUTCOME_CODES: Partial<Record<ApplyOutcome, string>> = {
  linked_elsewhere: APP_STORE_CODES.LINKED_ELSEWHERE,
  other_subscription: APP_STORE_CODES.OTHER_SUBSCRIPTION,
};

// POST /billing/app-store/transactions
//
// The app posts Apple's signed transactions after a purchase, on "Restore
// purchases", and for every update StoreKit delivers (renewals, refunds,
// purchases finished while the app was closed). Each is verified against
// Apple's root before anything is read from it. Any member may post: a
// restore by someone who paid binds what they paid for to the home they are
// in, and one already bound to another home is reported, never moved.
export const postTransactions = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    assertEnabled();
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<TransactionsInput>;
    const householdId = user.householdId!;

    const renewals = new Map<string, ReturnType<typeof verifyRenewalInfo>>();
    for (const jws of validatedBody.signedRenewalInfos ?? []) {
      try {
        const info = verifyRenewalInfo(jws);
        renewals.set(info.originalTransactionId, info);
      } catch (err) {
        // Renewal info only refines the grace period; a bad one is dropped.
        logger.warn({ err: (err as Error).message }, 'app_store_renewal_info_refused');
      }
    }

    const results: Array<{ outcome: ApplyOutcome; code?: string }> = [];
    for (const jws of validatedBody.signedTransactions) {
      let tx;
      try {
        tx = verifyTransaction(jws);
      } catch (err) {
        if (err instanceof AppStoreVerificationError) {
          logger.warn({ err: err.message }, 'app_store_transaction_refused');
          throw createHttpError(400, 'A signed transaction did not verify.', { expose: true });
        }
        throw err;
      }
      const result = await applyVerifiedTransaction(
        tx,
        renewals.get(tx.originalTransactionId) ?? null,
        householdId
      );
      results.push({
        outcome: result.outcome,
        ...(OUTCOME_CODES[result.outcome] ? { code: OUTCOME_CODES[result.outcome] } : {}),
      });
    }

    const sub = await getHouseholdSubscription(householdId);
    return successResponse({
      results,
      appStore: sub.appStore ?? null,
      entitledPlanId: getEntitledPlan(sub).id,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(userRateLimit({ perWindowMs: 60_000, max: 30 }))
  .use(validateBody(transactionsSchema));

const notificationSchema = z.object({ signedPayload: z.string().min(1).max(64_000) });
type NotificationInput = z.infer<typeof notificationSchema>;

// POST /billing/app-store/notifications  (public; Apple-signed)
//
// App Store Server Notifications v2. The body's JWS is the authentication:
// it is verified against Apple's pinned root before anything in it is read.
// A 200 tells Apple to stop retrying, so it is returned for everything that
// was handled or can never be (a test notification, another app's, a
// subscription no household has claimed yet: the app posts that one itself
// at its next launch). A payload that does not verify is a 400. A storage
// failure is a 500, which Apple retries on its own schedule.
export const notifications = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<NotificationInput>;
    if (!appStoreBillingEnabled()) {
      // Purchases off: only a parent's withdrawn consent is handled
      // (services/appConsent.ts). Anything else, including a payload that
      // does not verify, still learns only that the feature is not there.
      let consent: Awaited<ReturnType<typeof applyConsentNotification>> = null;
      try {
        consent = await applyConsentNotification(validatedBody.signedPayload);
      } catch (err) {
        if (!(err instanceof AppStoreVerificationError)) throw err;
      }
      if (!consent) assertEnabled();
      logger.info(
        { notificationType: consent?.notificationType, outcome: consent?.outcome },
        'app_store_notification'
      );
      return successResponse({ received: true });
    }
    try {
      const result = await applyNotification(validatedBody.signedPayload);
      logger.info(
        {
          notificationType: result.notificationType,
          outcome: result.outcome,
          householdId: result.householdId,
        },
        'app_store_notification'
      );
      return successResponse({ received: true });
    } catch (err) {
      if (err instanceof AppStoreVerificationError) {
        logger.warn({ err: err.message }, 'app_store_notification_refused');
        throw createHttpError(400, 'Notification did not verify.', { expose: true });
      }
      throw err;
    }
  }
)
  .use(rateLimit({ perWindowMs: 60_000, max: 120 }))
  .use(validateBody(notificationSchema));
