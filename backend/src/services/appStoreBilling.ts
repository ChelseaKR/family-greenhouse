import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import {
  appStoreState,
  subscriptionFromTransaction,
  type AppStoreRenewalInfo,
  type AppStoreSubscription,
  type AppStoreTransaction,
} from '../models/appStore.js';
import { getPlan, planRank, giftState, type PlanId } from '../models/plans.js';
import {
  APP_STORE_APP_APPLE_ID,
  APP_STORE_BUNDLE_ID,
  appStoreEnvironments,
} from '../config/appStore.js';
import { verifyAppleJws, AppStoreVerificationError, type VerifyOptions } from './appStoreJws.js';
import { getHouseholdSubscription, hasLiveStripeSubscription } from './billing.js';

/**
 * Apple In-App Purchase, server side (ADR 0041).
 *
 * The household row is the one source of truth for entitlement. Stripe
 * writes its fields from Stripe webhooks; this module writes exactly one map,
 * `appStore`, plus two internal attributes, from Apple's signed data:
 *
 *   - `appStoreOriginalTransactionId`  which Apple subscription the map
 *     describes. Never published.
 *   - `appStoreSignedDate`             Apple's signing time of the data last
 *     applied, so a delayed notification cannot overwrite a newer one.
 *
 * `getEntitledPlan` (models/plans.ts) reads Stripe and Apple together and
 * grants the stronger. Nothing here writes a Stripe field and nothing in
 * billing.ts writes these.
 *
 * Which household a subscription belongs to:
 *
 *   1. Before the purchase sheet opens, the app asks for the household's
 *      `appAccountToken` (a UUID, one per household, created once). StoreKit
 *      stamps it into every transaction of that subscription.
 *   2. The first verified transaction binds Apple's `originalTransactionId`
 *      to the household (`APPSTORE_TXN#<id>`, written once). From then on the
 *      binding decides, for the app's posts and Apple's notifications alike.
 *   3. A subscription bought outside the app's sheet (an offer code, a
 *      purchase started on the App Store page) has no token. The first
 *      household that posts it from the app, signed in, gets it.
 *
 * A subscription bound to one household is never applied to another: a
 * restore on a different household's account says so instead.
 */

export type ApplyOutcome =
  | 'applied'
  | 'stale'
  | 'ignored'
  | 'linked_elsewhere'
  | 'other_subscription'
  | 'unknown_household'
  | 'wrong_app';

const tokenKey = (token: string) => ({ PK: `APPSTORE_TOKEN#${token}`, SK: 'METADATA' });
const bindingKey = (otid: string) => ({ PK: `APPSTORE_TXN#${otid}`, SK: 'METADATA' });
const householdKey = (householdId: string) => ({ PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isConditionalFailure(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

/**
 * The household's `appAccountToken`, created on first use. Two concurrent
 * first calls may each mint one; the row's conditional write keeps the first,
 * and the loser's lookup row is harmless (it points at the same household).
 */
export async function getOrCreateAccountToken(householdId: string): Promise<string> {
  const row = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: householdKey(householdId) })
  );
  const existing: unknown = row.Item?.appStoreAccountToken;
  if (typeof existing === 'string' && UUID_RE.test(existing)) return existing;

  const token = randomUUID();
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...tokenKey(token),
        entityType: 'AppStoreAccountToken',
        householdId,
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: householdKey(householdId),
        UpdateExpression: 'SET appStoreAccountToken = :t',
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(appStoreAccountToken)',
        ExpressionAttributeValues: { ':t': token },
      })
    );
    return token;
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    const again = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: householdKey(householdId) })
    );
    const won: unknown = again.Item?.appStoreAccountToken;
    if (typeof won === 'string') return won;
    throw new Error('APP_STORE_HOUSEHOLD_MISSING', { cause: err });
  }
}

async function householdForToken(token: string | undefined): Promise<string | null> {
  if (!token || !UUID_RE.test(token)) return null;
  const res = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: tokenKey(token.toLowerCase()) })
  );
  const id: unknown = res.Item?.householdId;
  return typeof id === 'string' ? id : null;
}

async function householdForOriginalTransaction(otid: string): Promise<string | null> {
  const res = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: bindingKey(otid) }));
  const id: unknown = res.Item?.householdId;
  return typeof id === 'string' ? id : null;
}

/** Bind an Apple subscription to a household, once. Returns the household it is bound to. */
async function bindOriginalTransaction(otid: string, householdId: string): Promise<string> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...bindingKey(otid),
          entityType: 'AppStoreSubscriptionBinding',
          householdId,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return householdId;
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    return (await householdForOriginalTransaction(otid)) ?? householdId;
  }
}

/**
 * Write the subscription onto the household row.
 *
 * Applied when the row holds nothing from Apple, or the same subscription
 * signed no later than this, or a different subscription that has already
 * ended. Refused (`stale`) for older data about the same subscription, and
 * (`other_subscription`) while a different Apple subscription is still live
 * on the household: two Apple IDs paying for one home is a double charge
 * that only a refund fixes, so it is logged for the owner, not merged.
 */
async function writeSubscription(
  householdId: string,
  otid: string,
  sub: AppStoreSubscription,
  signedDate: number,
  now: Date
): Promise<'applied' | 'stale' | 'other_subscription'> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: householdKey(householdId),
        UpdateExpression: 'SET #as = :s, #otid = :o, #sd = :d',
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(#otid)' +
          ' OR (#otid = :o AND (attribute_not_exists(#sd) OR #sd <= :d))' +
          ' OR (#otid <> :o AND (#as.#exp < :now OR #as.#rev = :true)))',
        ExpressionAttributeNames: {
          '#as': 'appStore',
          '#otid': 'appStoreOriginalTransactionId',
          '#sd': 'appStoreSignedDate',
          '#exp': 'expiresAt',
          '#rev': 'revoked',
        },
        ExpressionAttributeValues: {
          ':s': sub,
          ':o': otid,
          ':d': signedDate,
          ':now': now.toISOString(),
          ':true': true,
        },
      })
    );
    return 'applied';
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    const row = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: householdKey(householdId) })
    );
    if (!row.Item) throw new Error('APP_STORE_HOUSEHOLD_MISSING', { cause: err });
    return row.Item.appStoreOriginalTransactionId === otid ? 'stale' : 'other_subscription';
  }
}

export interface ApplyResult {
  outcome: ApplyOutcome;
  householdId?: string;
  planId?: PlanId;
}

/**
 * Apply one verified transaction.
 *
 * `postedBy` is the signed-in household when the app posted it (a purchase or
 * a restore), and absent for Apple's notifications.
 */
export async function applyVerifiedTransaction(
  tx: AppStoreTransaction,
  renewal: AppStoreRenewalInfo | null,
  postedBy: string | null,
  now: Date = new Date()
): Promise<ApplyResult> {
  if (tx.bundleId !== APP_STORE_BUNDLE_ID) return { outcome: 'wrong_app' };
  if (!appStoreEnvironments().has(tx.environment)) {
    logger.warn({ environment: tx.environment }, 'app_store_environment_refused');
    return { outcome: 'ignored' };
  }
  const sub = subscriptionFromTransaction(tx, renewal);
  if (!sub) return { outcome: 'ignored' };

  let householdId = await householdForOriginalTransaction(tx.originalTransactionId);
  if (householdId && postedBy && householdId !== postedBy) {
    return { outcome: 'linked_elsewhere' };
  }
  if (!householdId) {
    const fromToken = await householdForToken(tx.appAccountToken);
    if (postedBy && fromToken && fromToken !== postedBy) return { outcome: 'linked_elsewhere' };
    const target = fromToken ?? postedBy;
    if (!target) return { outcome: 'unknown_household' };
    householdId = await bindOriginalTransaction(tx.originalTransactionId, target);
    if (postedBy && householdId !== postedBy) return { outcome: 'linked_elsewhere' };
  }

  const outcome = await writeSubscription(
    householdId,
    tx.originalTransactionId,
    sub,
    tx.signedDate,
    now
  );
  if (outcome === 'other_subscription') {
    logger.warn({ householdId }, 'app_store_second_subscription_on_household');
  }
  if (outcome === 'applied' && appStoreState({ appStore: sub }, now) === 'active') {
    // Both live at once is a double charge. The purchase guards refuse it in
    // both directions; this is the backstop that makes one visible.
    const current = await getHouseholdSubscription(householdId);
    if (hasLiveStripeSubscription(current)) {
      logger.warn({ householdId }, 'app_store_and_stripe_both_live');
    }
  }
  return { outcome, householdId, planId: sub.planId };
}

export interface VerifiedPost {
  transaction: AppStoreTransaction;
  renewal: AppStoreRenewalInfo | null;
}

function isTransactionPayload(
  p: Record<string, unknown>
): p is Record<string, unknown> & AppStoreTransaction {
  return (
    typeof p.transactionId === 'string' &&
    typeof p.originalTransactionId === 'string' &&
    typeof p.bundleId === 'string' &&
    typeof p.productId === 'string' &&
    typeof p.environment === 'string' &&
    typeof p.signedDate === 'number'
  );
}

export function verifyTransaction(jws: string, options?: VerifyOptions): AppStoreTransaction {
  const payload = verifyAppleJws(jws, options);
  if (!isTransactionPayload(payload)) {
    throw new AppStoreVerificationError('Signed transaction is missing required fields');
  }
  return payload;
}

export function verifyRenewalInfo(jws: string, options?: VerifyOptions): AppStoreRenewalInfo {
  const payload = verifyAppleJws(jws, options);
  if (typeof payload.originalTransactionId !== 'string') {
    throw new AppStoreVerificationError('Signed renewal info is missing originalTransactionId');
  }
  return payload as unknown as AppStoreRenewalInfo;
}

/**
 * App Store Server Notifications v2. Verifies the outer payload and the
 * transaction and renewal info inside it, then applies the transaction like
 * any other: every notification type that carries a transaction is handled by
 * re-deriving the subscription from Apple's current data (a renewal moves
 * `expiresAt`, an expiry or a failed renewal lets it pass, a refund or a
 * revoke sets the revocation date, a reversed refund clears it). Re-applying
 * the same notification is harmless, so there is no ledger.
 */
export async function applyNotification(
  signedPayload: string,
  options?: VerifyOptions,
  now: Date = new Date()
): Promise<ApplyResult & { notificationType?: string }> {
  const payload = verifyAppleJws<{
    notificationType?: string;
    subtype?: string;
    data?: {
      bundleId?: string;
      appAppleId?: number;
      environment?: string;
      signedTransactionInfo?: string;
      signedRenewalInfo?: string;
    };
  }>(signedPayload, options);
  const notificationType = payload.notificationType;
  const data = payload.data;
  if (!data || data.bundleId !== APP_STORE_BUNDLE_ID) {
    return { outcome: 'wrong_app', notificationType };
  }
  if (
    data.environment === 'Production' &&
    typeof data.appAppleId === 'number' &&
    data.appAppleId !== APP_STORE_APP_APPLE_ID
  ) {
    return { outcome: 'wrong_app', notificationType };
  }
  if (!data.signedTransactionInfo) return { outcome: 'ignored', notificationType };
  const transaction = verifyTransaction(data.signedTransactionInfo, options);
  const renewal = data.signedRenewalInfo
    ? verifyRenewalInfo(data.signedRenewalInfo, options)
    : null;
  const result = await applyVerifiedTransaction(transaction, renewal, null, now);
  return { ...result, notificationType };
}

export type PurchaseRefusal =
  'STRIPE_SUBSCRIPTION_ACTIVE' | 'APP_STORE_SUBSCRIPTION_ACTIVE' | 'PLAN_ALREADY_INCLUDED';

/**
 * Whether a household may start an App Store purchase of `planId` now, and if
 * not, why. Refuses a second way of paying for the same home:
 *
 *   - a live Stripe subscription (any tier; changing it goes through the
 *     Stripe customer portal, which the app never links to);
 *   - an App Store subscription that is still active (upgrades and
 *     downgrades go through Apple's own Manage Subscriptions sheet, which
 *     keeps them inside one subscription);
 *   - a lifetime purchase or a running gift that already includes the tier.
 *
 * A no-card trial does not refuse: buying during it is how the trial converts,
 * and the trial stops counting the moment an App Store subscription exists.
 */
export async function purchaseRefusal(
  householdId: string,
  planId: PlanId,
  now: Date = new Date()
): Promise<PurchaseRefusal | null> {
  const sub = await getHouseholdSubscription(householdId);
  if (hasLiveStripeSubscription(sub)) return 'STRIPE_SUBSCRIPTION_ACTIVE';
  if (appStoreState(sub, now) === 'active') return 'APP_STORE_SUBSCRIPTION_ACTIVE';
  const wanted = planRank(getPlan(planId).id);
  if (sub.lifetimePlanId && planRank(getPlan(sub.lifetimePlanId).id) >= wanted) {
    return 'PLAN_ALREADY_INCLUDED';
  }
  if (giftState(sub, now) === 'active' && planRank(getPlan(sub.giftPlanId).id) >= wanted) {
    return 'PLAN_ALREADY_INCLUDED';
  }
  return null;
}

/**
 * True when a web (Stripe) plan checkout must be refused because the
 * household pays Apple. Read on every plan checkout, whatever the switch
 * says, so a household that subscribed in the app is never sold a second
 * subscription on the web.
 */
export async function appStoreBlocksWebCheckout(
  householdId: string,
  now: Date = new Date()
): Promise<boolean> {
  const sub = await getHouseholdSubscription(householdId);
  return appStoreState({ appStore: sub?.appStore }, now) === 'active';
}
