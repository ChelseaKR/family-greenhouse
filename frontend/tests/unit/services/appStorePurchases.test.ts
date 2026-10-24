/**
 * Apple In-App Purchase wiring (ADR 0041): when it is offered at all, the
 * product ids it sells, and how a purchase and a restore talk to the server
 * and to StoreKit. The StoreKit plugin module is mocked; the API is msw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';
import { useAuthStore } from '@/store/authStore';

const plugin = vi.hoisted(() => ({
  getProducts: vi.fn(),
  purchase: vi.fn(),
  currentEntitlements: vi.fn(),
  restore: vi.fn(),
  finish: vi.fn(),
  manageSubscriptions: vi.fn(),
  onTransaction: vi.fn(),
}));
vi.mock('@/services/appStorePurchasesPlugin', () => plugin);

import {
  APP_STORE_PRODUCT_IDS,
  NATIVE_PURCHASES_METHODS,
  appStorePurchasesAvailable,
  buyPlan,
  loadStoreProducts,
  restorePurchases,
} from '@/services/appStorePurchases';

const API = 'http://localhost:4000';

function pretendShell(platform: 'ios' | 'android', withPlugin = true) {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    PluginHeaders: withPlugin
      ? [{ name: 'NativePurchases', methods: NATIVE_PURCHASES_METHODS.map((name) => ({ name })) }]
      : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    accessToken: 'access-1',
    user: {
      id: 'u-me',
      email: 'me@example.com',
      name: 'Sam',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    activeHouseholdId: 'hh-1',
  });
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  vi.unstubAllEnvs();
});

describe('appStorePurchasesAvailable', () => {
  it('is off by default, even in the iPhone app with the plugin', () => {
    pretendShell('ios');
    expect(appStorePurchasesAvailable()).toBe(false);
  });

  it('is on only with the build switch, on iOS, with the plugin registered', () => {
    vi.stubEnv('VITE_APP_STORE_PURCHASES', 'true');
    pretendShell('ios');
    expect(appStorePurchasesAvailable()).toBe(true);
    pretendShell('ios', false);
    expect(appStorePurchasesAvailable()).toBe(false);
    pretendShell('android');
    expect(appStorePurchasesAvailable()).toBe(false);
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    expect(appStorePurchasesAvailable()).toBe(false);
  });

  it('treats anything but exactly "true" as off', () => {
    vi.stubEnv('VITE_APP_STORE_PURCHASES', '1');
    pretendShell('ios');
    expect(appStorePurchasesAvailable()).toBe(false);
  });
});

describe('the product ids', () => {
  it('match the backend catalog and the local StoreKit configuration', () => {
    const backend = readFileSync(
      join(__dirname, '../../../../backend/src/models/appStore.ts'),
      'utf8'
    );
    const storekit = JSON.parse(
      readFileSync(join(__dirname, '../../../ios/App/App/FamilyGreenhouse.storekit'), 'utf8')
    );
    const configured = storekit.subscriptionGroups[0].subscriptions.map(
      (s: { productID: string }) => s.productID
    );
    for (const id of Object.values(APP_STORE_PRODUCT_IDS)) {
      expect(backend).toContain(`'${id}'`);
      expect(configured).toContain(id);
    }
  });
});

describe('loadStoreProducts', () => {
  it('keys the App Store products by tier', async () => {
    plugin.getProducts.mockResolvedValue([
      { id: APP_STORE_PRODUCT_IDS.garden, displayName: 'Garden', displayPrice: '$4.99' },
    ]);
    const products = await loadStoreProducts();
    expect(products.garden?.displayPrice).toBe('$4.99');
    expect(products.greenhouse).toBeUndefined();
  });
});

describe('buyPlan', () => {
  const householdUuid = '00000000-0000-4000-8000-000000000001';

  it('asks the server first, buys with its token, posts the result and finishes it', async () => {
    let posted: unknown = null;
    server.use(
      http.post(`${API}/billing/app-store/purchase-intent`, () =>
        HttpResponse.json({
          productId: APP_STORE_PRODUCT_IDS.garden,
          appAccountToken: householdUuid,
        })
      ),
      http.post(`${API}/billing/app-store/transactions`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({
          results: [{ outcome: 'applied' }],
          appStore: { planId: 'garden', state: 'active' },
        });
      })
    );
    plugin.purchase.mockResolvedValue({
      status: 'purchased',
      signedTransaction: 'jws.tx.sig',
      transactionId: '42',
      signedRenewalInfo: 'jws.renewal.sig',
    });
    plugin.finish.mockResolvedValue(true);

    const outcome = await buyPlan('garden');

    expect(plugin.purchase).toHaveBeenCalledWith(APP_STORE_PRODUCT_IDS.garden, householdUuid);
    expect(posted).toEqual({
      signedTransactions: ['jws.tx.sig'],
      signedRenewalInfos: ['jws.renewal.sig'],
    });
    expect(plugin.finish).toHaveBeenCalledWith('42');
    expect(outcome.kind).toBe('purchased');
  });

  it('never opens the purchase sheet when the server refuses a second way to pay', async () => {
    server.use(
      http.post(`${API}/billing/app-store/purchase-intent`, () =>
        HttpResponse.json(
          {
            message: 'This household already has a paid plan.',
            details: { code: 'STRIPE_SUBSCRIPTION_ACTIVE' },
          },
          { status: 409 }
        )
      )
    );
    const outcome = await buyPlan('garden');
    expect(outcome).toEqual({ kind: 'refused', code: 'STRIPE_SUBSCRIPTION_ACTIVE' });
    expect(plugin.purchase).not.toHaveBeenCalled();
  });

  it('reports purchases switched off on the server as unavailable', async () => {
    server.use(
      http.post(`${API}/billing/app-store/purchase-intent`, () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })
      )
    );
    expect(await buyPlan('greenhouse')).toEqual({ kind: 'unavailable' });
  });

  it('leaves the transaction unfinished when the server cannot be reached', async () => {
    server.use(
      http.post(`${API}/billing/app-store/purchase-intent`, () =>
        HttpResponse.json({
          productId: APP_STORE_PRODUCT_IDS.garden,
          appAccountToken: householdUuid,
        })
      ),
      http.post(`${API}/billing/app-store/transactions`, () => HttpResponse.error())
    );
    plugin.purchase.mockResolvedValue({
      status: 'purchased',
      signedTransaction: 'jws.tx.sig',
      transactionId: '42',
    });
    expect((await buyPlan('garden')).kind).toBe('failed');
    expect(plugin.finish).not.toHaveBeenCalled();
  });

  it('passes a cancelled sheet and Ask to Buy through without posting', async () => {
    server.use(
      http.post(`${API}/billing/app-store/purchase-intent`, () =>
        HttpResponse.json({
          productId: APP_STORE_PRODUCT_IDS.garden,
          appAccountToken: householdUuid,
        })
      )
    );
    plugin.purchase.mockResolvedValueOnce({ status: 'cancelled' });
    expect(await buyPlan('garden')).toEqual({ kind: 'cancelled' });
    plugin.purchase.mockResolvedValueOnce({ status: 'pending' });
    expect(await buyPlan('garden')).toEqual({ kind: 'pending' });
  });
});

describe('restorePurchases', () => {
  it('says so when this Apple ID holds nothing', async () => {
    plugin.restore.mockResolvedValue([]);
    expect(await restorePurchases()).toEqual({ kind: 'nothing' });
  });

  it('reports a subscription that belongs to another household', async () => {
    plugin.restore.mockResolvedValue([{ signedTransaction: 'jws', transactionId: '7' }]);
    server.use(
      http.post(`${API}/billing/app-store/transactions`, () =>
        HttpResponse.json({
          results: [{ outcome: 'linked_elsewhere', code: 'APP_STORE_LINKED_ELSEWHERE' }],
          appStore: null,
        })
      )
    );
    expect(await restorePurchases()).toEqual({
      kind: 'refused',
      code: 'APP_STORE_LINKED_ELSEWHERE',
    });
  });
});
