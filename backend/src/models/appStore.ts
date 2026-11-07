import type { PlanId } from './plans.js';

/**
 * Apple In-App Purchase for the iPhone app (ADR 0041).
 *
 * This module is pure: the product catalog, the shape of a verified App Store
 * transaction, and the rule that turns one into an entitlement on the
 * household row. Verifying Apple's signatures is services/appStoreJws.ts;
 * reading and writing rows is services/appStoreBilling.ts.
 *
 * It imports nothing at runtime from models/plans.ts, because plans.ts
 * imports `appStoreState` from here to resolve entitlement, and a runtime
 * cycle between the two would leave one of them half-initialized.
 */

/**
 * The auto-renewable subscriptions, one per paid tier, in ONE subscription
 * group so Apple handles upgrades and downgrades between them itself (a
 * person can hold only one subscription in a group at a time).
 *
 * The ids are fixed once created in App Store Connect and can never be
 * reused, even after deletion, so they are spelled out here rather than
 * derived. The local StoreKit configuration
 * (frontend/ios/App/App/FamilyGreenhouse.storekit) and the owner steps
 * name the same four strings; a unit test holds them together.
 */
export const APP_STORE_SUBSCRIPTION_GROUP = 'Family Greenhouse plans';

export const APP_STORE_PRODUCTS = {
  'net.familygreenhouse.app.garden.monthly': 'garden',
  'net.familygreenhouse.app.greenhouse.monthly': 'greenhouse',
} as const satisfies Record<string, Exclude<PlanId, 'seedling'>>;

export type AppStoreProductId = keyof typeof APP_STORE_PRODUCTS;

export function isAppStoreProductId(id: unknown): id is AppStoreProductId {
  return typeof id === 'string' && Object.hasOwn(APP_STORE_PRODUCTS, id);
}

export function planForAppStoreProduct(id: unknown): Exclude<PlanId, 'seedling'> | null {
  return isAppStoreProductId(id) ? APP_STORE_PRODUCTS[id] : null;
}

export function appStoreProductForPlan(planId: string): AppStoreProductId | null {
  for (const [productId, plan] of Object.entries(APP_STORE_PRODUCTS)) {
    if (plan === planId) return productId as AppStoreProductId;
  }
  return null;
}

/**
 * The fields of Apple's JWSTransactionDecodedPayload this code reads. Dates
 * are milliseconds since the epoch, as Apple sends them.
 * https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload
 */
export interface AppStoreTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  environment: string;
  signedDate: number;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  revocationReason?: number;
  isUpgraded?: boolean;
  appAccountToken?: string;
  type?: string;
}

/**
 * The fields of Apple's JWSRenewalInfoDecodedPayload this code reads.
 * https://developer.apple.com/documentation/appstoreserverapi/jwsrenewalinfodecodedpayload
 */
export interface AppStoreRenewalInfo {
  originalTransactionId: string;
  autoRenewStatus?: number;
  autoRenewProductId?: string;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  signedDate?: number;
  environment?: string;
}

/**
 * What the household row records about its App Store subscription, and what
 * GET /billing/me publishes as `appStore`.
 *
 *   - `planId`      the tier the current transaction's product grants.
 *   - `expiresAt`   ISO 8601: when access ends unless Apple reports a renewal.
 *                   The later of the transaction's `expiresDate` and a billing
 *                   grace period's end, or the revocation date for a refund.
 *   - `willRenew`   Apple's auto-renew status, when known (display only).
 *   - `revoked`     Apple refunded or revoked the transaction.
 *   - `environment` `Production` or `Sandbox` (App Review and TestFlight buy
 *                   in Sandbox against the production server).
 *
 * The original transaction id that binds the subscription to this household
 * is kept on the row but is NOT part of this shape, so it never reaches a
 * client.
 */
export interface AppStoreSubscription {
  planId: Exclude<PlanId, 'seedling'>;
  productId: AppStoreProductId;
  expiresAt: string;
  willRenew?: boolean;
  revoked?: boolean;
  environment: string;
}

/**
 * Turn a verified transaction (and, when Apple sent it, the renewal info) into
 * the row's App Store subscription. Returns null for a transaction that grants
 * nothing here: an unknown product, or one Apple has marked upgraded (its
 * replacement is a separate, newer transaction that carries the new tier).
 */
export function subscriptionFromTransaction(
  tx: AppStoreTransaction,
  renewal?: AppStoreRenewalInfo | null
): AppStoreSubscription | null {
  if (!isAppStoreProductId(tx.productId)) return null;
  if (tx.isUpgraded === true) return null;
  const planId = APP_STORE_PRODUCTS[tx.productId];
  const revoked = typeof tx.revocationDate === 'number';
  let expiresMs: number;
  if (revoked) {
    expiresMs = tx.revocationDate as number;
  } else {
    if (typeof tx.expiresDate !== 'number') return null;
    expiresMs = tx.expiresDate;
    const grace =
      renewal && renewal.originalTransactionId === tx.originalTransactionId
        ? renewal.gracePeriodExpiresDate
        : undefined;
    if (typeof grace === 'number' && grace > expiresMs) expiresMs = grace;
  }
  if (!Number.isFinite(expiresMs)) return null;
  const willRenew =
    renewal && renewal.originalTransactionId === tx.originalTransactionId
      ? typeof renewal.autoRenewStatus === 'number'
        ? renewal.autoRenewStatus === 1
        : undefined
      : undefined;
  return {
    planId,
    productId: tx.productId,
    expiresAt: new Date(expiresMs).toISOString(),
    ...(willRenew === undefined ? {} : { willRenew }),
    ...(revoked ? { revoked: true } : {}),
    environment: tx.environment,
  };
}

/**
 * Where a household stands on its App Store subscription at `now`.
 *
 *   - `none`    nothing recorded, or what is recorded does not parse.
 *   - `active`  now is before `expiresAt` and Apple has not revoked it.
 *   - `ended`   expired, or refunded/revoked.
 *
 * Derived on every read, like the no-card trial and gifts: Apple's renewal
 * arrives as a notification that moves `expiresAt` forward, and a missed one
 * fails toward ending access, never toward keeping it forever.
 */
export type AppStoreState = 'active' | 'ended' | 'none';

export function appStoreState(
  sub: { appStore?: Partial<AppStoreSubscription> | null },
  now: Date = new Date()
): AppStoreState {
  const s = sub.appStore;
  if (!s || !s.expiresAt || !planForAppStoreProduct(s.productId)) return 'none';
  if (s.planId !== planForAppStoreProduct(s.productId)) return 'none';
  const ends = Date.parse(s.expiresAt);
  if (!Number.isFinite(ends)) return 'none';
  if (s.revoked === true) return 'ended';
  return now.getTime() < ends ? 'active' : 'ended';
}

/**
 * Read the row's `appStore` map back into the published shape, keeping only
 * the fields this module writes and dropping a map that does not describe a
 * known product (a row someone edited by hand grants nothing).
 */
export function readAppStoreSubscription(raw: unknown): AppStoreSubscription | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const planId = planForAppStoreProduct(r.productId);
  if (!planId || r.planId !== planId) return undefined;
  if (typeof r.expiresAt !== 'string' || typeof r.environment !== 'string') return undefined;
  return {
    planId,
    productId: r.productId as AppStoreProductId,
    expiresAt: r.expiresAt,
    ...(typeof r.willRenew === 'boolean' ? { willRenew: r.willRenew } : {}),
    ...(r.revoked === true ? { revoked: true } : {}),
    environment: r.environment,
  };
}
