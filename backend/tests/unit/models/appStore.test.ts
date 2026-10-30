/**
 * App Store subscriptions as entitlement (ADR 0041): the product catalog, the
 * transaction-to-row rule, and how `getEntitledPlan` reads Apple beside
 * Stripe, lifetime, gifts and the no-card trial.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_STORE_PRODUCTS,
  appStoreProductForPlan,
  appStoreState,
  readAppStoreSubscription,
  subscriptionFromTransaction,
  type AppStoreTransaction,
} from '../../../src/models/appStore.js';
import {
  getEntitledPlan,
  getEntitledPlanForIssuedGrant,
  getMeteredPlanId,
  noCardTrialState,
} from '../../../src/models/plans.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const DAY = 86_400_000;

function tx(over: Partial<AppStoreTransaction> = {}): AppStoreTransaction {
  return {
    transactionId: '2000000001',
    originalTransactionId: '2000000000',
    bundleId: 'net.familygreenhouse.app',
    productId: 'net.familygreenhouse.app.garden.monthly',
    environment: 'Production',
    signedDate: NOW.getTime(),
    purchaseDate: NOW.getTime() - DAY,
    expiresDate: NOW.getTime() + 29 * DAY,
    ...over,
  };
}

const active = {
  planId: 'garden' as const,
  productId: 'net.familygreenhouse.app.garden.monthly' as const,
  expiresAt: new Date(NOW.getTime() + DAY).toISOString(),
  environment: 'Production',
};

describe('the App Store product catalog', () => {
  it('maps one monthly product to each paid tier', () => {
    expect(Object.values(APP_STORE_PRODUCTS).sort()).toEqual(['garden', 'greenhouse']);
    expect(appStoreProductForPlan('garden')).toBe('net.familygreenhouse.app.garden.monthly');
    expect(appStoreProductForPlan('greenhouse')).toBe(
      'net.familygreenhouse.app.greenhouse.monthly'
    );
    expect(appStoreProductForPlan('seedling')).toBeNull();
  });

  it('matches the local StoreKit configuration the iOS app tests with', () => {
    const path = join(__dirname, '../../../../frontend/ios/App/App/FamilyGreenhouse.storekit');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const products = config.subscriptionGroups.flatMap(
      (g: { subscriptions: Array<{ productID: string; displayPrice: string }> }) => g.subscriptions
    );
    expect(products.map((p: { productID: string }) => p.productID).sort()).toEqual(
      Object.keys(APP_STORE_PRODUCTS).sort()
    );
    // The App Store prices match the catalog's monthly prices.
    const price = Object.fromEntries(
      products.map((p: { productID: string; displayPrice: string }) => [
        p.productID,
        p.displayPrice,
      ])
    );
    expect(price['net.familygreenhouse.app.garden.monthly']).toBe('4.99');
    expect(price['net.familygreenhouse.app.greenhouse.monthly']).toBe('9.99');
    expect(config.subscriptionGroups).toHaveLength(1);
  });
});

describe('subscriptionFromTransaction', () => {
  it('records the tier, the expiry and the environment', () => {
    expect(subscriptionFromTransaction(tx())).toEqual({
      planId: 'garden',
      productId: 'net.familygreenhouse.app.garden.monthly',
      expiresAt: new Date(NOW.getTime() + 29 * DAY).toISOString(),
      environment: 'Production',
    });
  });

  it('extends access through a billing grace period from the renewal info', () => {
    const sub = subscriptionFromTransaction(tx({ expiresDate: NOW.getTime() - DAY }), {
      originalTransactionId: '2000000000',
      autoRenewStatus: 1,
      gracePeriodExpiresDate: NOW.getTime() + 5 * DAY,
    });
    expect(sub?.expiresAt).toBe(new Date(NOW.getTime() + 5 * DAY).toISOString());
    expect(sub?.willRenew).toBe(true);
    expect(appStoreState({ appStore: sub }, NOW)).toBe('active');
  });

  it('ignores renewal info for a different subscription', () => {
    const sub = subscriptionFromTransaction(tx({ expiresDate: NOW.getTime() - DAY }), {
      originalTransactionId: 'other',
      gracePeriodExpiresDate: NOW.getTime() + 5 * DAY,
    });
    expect(appStoreState({ appStore: sub }, NOW)).toBe('ended');
  });

  it('ends access at the revocation date on a refund', () => {
    const sub = subscriptionFromTransaction(tx({ revocationDate: NOW.getTime() - 1000 }));
    expect(sub?.revoked).toBe(true);
    expect(appStoreState({ appStore: sub }, NOW)).toBe('ended');
  });

  it('grants nothing for an unknown product, an upgraded transaction, or no expiry', () => {
    expect(subscriptionFromTransaction(tx({ productId: 'com.other.app.x' }))).toBeNull();
    expect(subscriptionFromTransaction(tx({ isUpgraded: true }))).toBeNull();
    expect(subscriptionFromTransaction(tx({ expiresDate: undefined }))).toBeNull();
  });
});

describe('readAppStoreSubscription', () => {
  it('keeps only the fields this module writes', () => {
    expect(readAppStoreSubscription({ ...active, extra: 1 })).toEqual(active);
  });

  it('drops a map whose tier does not match its product', () => {
    expect(readAppStoreSubscription({ ...active, planId: 'greenhouse' })).toBeUndefined();
    expect(readAppStoreSubscription('garden')).toBeUndefined();
    expect(readAppStoreSubscription(undefined)).toBeUndefined();
  });
});

describe('getEntitledPlan with an App Store subscription', () => {
  it('grants the bought tier while it runs and Seedling after', () => {
    expect(getEntitledPlan({ planId: 'seedling', appStore: active }, NOW).id).toBe('garden');
    const later = new Date(NOW.getTime() + 2 * DAY);
    expect(getEntitledPlan({ planId: 'seedling', appStore: active }, later).id).toBe('seedling');
  });

  it('never lowers a stronger Stripe plan, lifetime purchase or gift', () => {
    expect(
      getEntitledPlan({ planId: 'greenhouse', status: 'active', appStore: active }, NOW).id
    ).toBe('greenhouse');
    expect(getEntitledPlan({ lifetimePlanId: 'greenhouse', appStore: active }, NOW).id).toBe(
      'greenhouse'
    );
    expect(
      getEntitledPlan(
        { giftPlanId: 'greenhouse', giftEndsAt: '2026-12-01T00:00:00.000Z', appStore: active },
        NOW
      ).id
    ).toBe('greenhouse');
  });

  it('raises a lapsed Stripe household that pays Apple', () => {
    expect(
      getEntitledPlan(
        {
          planId: 'greenhouse',
          status: 'canceled',
          appStore: {
            ...active,
            planId: 'greenhouse',
            productId: 'net.familygreenhouse.app.greenhouse.monthly',
          },
        },
        NOW
      ).id
    ).toBe('greenhouse');
  });

  it('carries issued grants on the App Store tier too', () => {
    expect(getEntitledPlanForIssuedGrant({ planId: 'seedling', appStore: active }, NOW).id).toBe(
      'garden'
    );
  });

  it('ends the no-card trial and meters at the bought tier', () => {
    const sub = {
      planId: 'seedling',
      noCardTrialEndsAt: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      appStore: active,
    };
    expect(noCardTrialState(sub, NOW)).toBe('none');
    expect(getMeteredPlanId(sub, NOW)).toBe('garden');
  });

  it('does not hand a lapsed App Store household the trial back', () => {
    const sub = {
      planId: 'seedling',
      noCardTrialEndsAt: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      appStore: { ...active, expiresAt: new Date(NOW.getTime() - DAY).toISOString() },
    };
    expect(noCardTrialState(sub, NOW)).toBe('none');
    expect(getEntitledPlan(sub, NOW).id).toBe('seedling');
  });
});
