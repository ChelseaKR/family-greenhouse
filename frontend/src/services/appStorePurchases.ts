import { isAxiosError } from 'axios';
import { api } from './api';
import { appStorePurchasesAvailable } from './appStoreAvailability';
import type { AppStoreSubscriptionView, PlanId } from './billingService';
import type { SignedTransaction, StoreProduct } from './appStorePurchasesPlugin';
import { AGE_ASSURANCE_POLICY } from '@/config/ageAssurance';
import { checkoutGate } from '@/lib/ageSignal';
import { loadAgeSignal } from '@/services/nativeAgeRange';

/**
 * Apple In-App Purchase in the iPhone app (ADR 0041).
 *
 * Two switches must both be on before any of this shows:
 *
 *   1. The BUILD: `VITE_APP_STORE_PURCHASES=true` in the store build's
 *      environment. Off by default, and in every web build.
 *   2. The BINARY: the iOS app registers the NativePurchases plugin
 *      (ios/App/App/NativePurchasesPlugin.swift). Read from the bridge's
 *      plugin headers, never from the platform alone (lib/platform.ts
 *      `hasNativePlugin`, ADR 0034).
 *
 * The server has its own switch (`APP_STORE_BILLING_ENABLED`); with it off
 * the purchase intent answers 404 and the app says purchases are unavailable.
 *
 * Inside the app the only prices shown are the App Store's own
 * (`displayPrice` from StoreKit), and nothing points at the website or at
 * Stripe (App Review Guideline 3.1.1).
 */

export type PaidPlanId = Exclude<PlanId, 'seedling'>;

/**
 * The App Store product for each paid tier. Mirrors
 * backend/src/models/appStore.ts `APP_STORE_PRODUCTS` and the local StoreKit
 * configuration; tests/unit/services/appStorePurchases.test.ts holds the three
 * together.
 */
export const APP_STORE_PRODUCT_IDS: Record<PaidPlanId, string> = {
  garden: 'net.familygreenhouse.app.garden.monthly',
  greenhouse: 'net.familygreenhouse.app.greenhouse.monthly',
};

// Where purchases are offered at all lives in its own small module, so the
// entry chunk (App, LockedFeature, BillingSettings ask it) does not carry the
// purchase flow. Re-exported here for callers that already load this one.
export {
  NATIVE_PURCHASES_PLUGIN,
  NATIVE_PURCHASES_METHODS,
  appStorePurchasesAvailable,
  appStorePurchasesEnabled,
} from './appStoreAvailability';

const loadPlugin = () => import('@/services/appStorePurchasesPlugin');

/** Refusals the server names, so the app can say what is true without a web pointer. */
export type PurchaseRefusalCode =
  /** Refused in the app, not by the server: decision B2 (config/ageAssurance.ts). */
  | 'ADULT_REQUIRED'
  | 'STRIPE_SUBSCRIPTION_ACTIVE'
  | 'APP_STORE_SUBSCRIPTION_ACTIVE'
  | 'PLAN_ALREADY_INCLUDED'
  | 'APP_STORE_LINKED_ELSEWHERE'
  | 'APP_STORE_OTHER_SUBSCRIPTION';

export type BuyOutcome =
  | { kind: 'purchased'; appStore: AppStoreSubscriptionView | null }
  | { kind: 'pending' }
  | { kind: 'cancelled' }
  | { kind: 'refused'; code: PurchaseRefusalCode }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

export type RestoreOutcome =
  | { kind: 'restored'; appStore: AppStoreSubscriptionView | null }
  | { kind: 'nothing' }
  | { kind: 'refused'; code: PurchaseRefusalCode }
  | { kind: 'failed' };

interface PostResult {
  results: Array<{ outcome: string; code?: string }>;
  appStore: AppStoreSubscriptionView | null;
}

function errorCode(err: unknown): string | undefined {
  if (!isAxiosError(err)) return undefined;
  const data = err.response?.data as { details?: { code?: string } } | undefined;
  return data?.details?.code;
}

function isRefusal(code: string | undefined): code is PurchaseRefusalCode {
  return (
    code === 'STRIPE_SUBSCRIPTION_ACTIVE' ||
    code === 'APP_STORE_SUBSCRIPTION_ACTIVE' ||
    code === 'PLAN_ALREADY_INCLUDED' ||
    code === 'APP_STORE_LINKED_ELSEWHERE' ||
    code === 'APP_STORE_OTHER_SUBSCRIPTION'
  );
}

export const appStoreApi = {
  async purchaseIntent(
    planId: PaidPlanId
  ): Promise<{ productId: string; appAccountToken: string }> {
    const { data } = await api.post('/billing/app-store/purchase-intent', { planId });
    return data;
  },
  async postTransactions(transactions: SignedTransaction[]): Promise<PostResult> {
    const { data } = await api.post('/billing/app-store/transactions', {
      signedTransactions: transactions.map((t) => t.signedTransaction),
      signedRenewalInfos: transactions
        .map((t) => t.signedRenewalInfo)
        .filter((s): s is string => typeof s === 'string' && s.length > 0),
    });
    return data;
  },
};

/** Post to the server, then finish each transaction the server answered for. */
async function deliver(transactions: SignedTransaction[]): Promise<PostResult> {
  const result = await appStoreApi.postTransactions(transactions);
  // The server gave a definite answer for every one, so StoreKit can stop
  // redelivering them. A network failure throws before this and leaves them
  // unfinished, which is what makes StoreKit try again at the next launch.
  const plugin = await loadPlugin();
  await Promise.all(
    transactions.map((t) =>
      t.transactionId ? plugin.finish(t.transactionId) : Promise.resolve(false)
    )
  );
  return result;
}

/** The App Store's own products for both paid tiers, keyed by tier. */
export async function loadStoreProducts(): Promise<Partial<Record<PaidPlanId, StoreProduct>>> {
  const plugin = await loadPlugin();
  const products = await plugin.getProducts(Object.values(APP_STORE_PRODUCT_IDS));
  const out: Partial<Record<PaidPlanId, StoreProduct>> = {};
  for (const [plan, id] of Object.entries(APP_STORE_PRODUCT_IDS) as Array<[PaidPlanId, string]>) {
    const found = products.find((p) => p.id === id);
    if (found) out[plan] = found;
  }
  return out;
}

export async function buyPlan(planId: PaidPlanId): Promise<BuyOutcome> {
  // App-store age assurance (decision B). With the recommended `termsOnly`
  // this never refuses: the Terms carry the adult-payer rule and Apple's Ask
  // to Buy puts a minor's purchase in front of a parent.
  if (checkoutGate(await loadAgeSignal(), AGE_ASSURANCE_POLICY) === 'blocked') {
    return { kind: 'refused', code: 'ADULT_REQUIRED' };
  }
  let intent: { productId: string; appAccountToken: string };
  try {
    intent = await appStoreApi.purchaseIntent(planId);
  } catch (err) {
    const code = errorCode(err);
    if (isRefusal(code)) return { kind: 'refused', code };
    if (isAxiosError(err) && err.response?.status === 404) return { kind: 'unavailable' };
    return { kind: 'failed' };
  }
  try {
    const plugin = await loadPlugin();
    const result = await plugin.purchase(intent.productId, intent.appAccountToken);
    if (result.status === 'cancelled') return { kind: 'cancelled' };
    if (result.status === 'pending') return { kind: 'pending' };
    const posted = await deliver([result]);
    const refusal = posted.results.map((r) => r.code).find(isRefusal);
    if (refusal) return { kind: 'refused', code: refusal };
    return { kind: 'purchased', appStore: posted.appStore };
  } catch {
    return { kind: 'failed' };
  }
}

/** "Restore purchases": sync with the App Store, then post what this Apple ID holds. */
export async function restorePurchases(): Promise<RestoreOutcome> {
  try {
    const plugin = await loadPlugin();
    const transactions = await plugin.restore();
    if (transactions.length === 0) return { kind: 'nothing' };
    const posted = await deliver(transactions);
    const refusal = posted.results.map((r) => r.code).find(isRefusal);
    if (refusal && !posted.appStore) return { kind: 'refused', code: refusal };
    return posted.appStore ? { kind: 'restored', appStore: posted.appStore } : { kind: 'nothing' };
  } catch {
    return { kind: 'failed' };
  }
}

export async function openManageSubscriptions(): Promise<boolean> {
  try {
    const plugin = await loadPlugin();
    return await plugin.manageSubscriptions();
  } catch {
    return false;
  }
}

/**
 * Keep the server current from the device: post what this Apple ID holds
 * now, then every update StoreKit delivers while the app runs (a renewal, a
 * refund, an Ask to Buy approval, a purchase that finished while the app was
 * closed). Apple's server notifications carry the same facts; this is the
 * path that does not depend on them. Returns a stop function. Never throws.
 */
export async function startTransactionSync(onChange: () => void): Promise<() => void> {
  if (!appStorePurchasesAvailable()) return () => {};
  try {
    const plugin = await loadPlugin();
    const stop = await plugin.onTransaction((update) => {
      void deliver([update])
        .then(onChange)
        .catch(() => {
          // Left unfinished: StoreKit delivers it again at the next launch.
        });
    });
    const held = await plugin.currentEntitlements();
    if (held.length > 0) {
      await appStoreApi
        .postTransactions(held)
        .then(onChange)
        .catch(() => {});
    }
    return stop;
  } catch {
    return () => {};
  }
}
