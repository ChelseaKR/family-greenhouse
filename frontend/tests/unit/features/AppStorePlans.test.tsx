/**
 * Settings → Plan in the iPhone app with App Store purchases on (ADR 0041),
 * and the locked-feature card there. Guideline 3.1.1: the only price shown is
 * the App Store's (`displayPrice` from StoreKit), never the catalog's or the
 * website's, and nothing names another way to pay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';
import { useAuthStore } from '@/store/authStore';
import type { SubscriptionState } from '@/services/billingService';

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

import { AppStorePlans } from '@/features/billing/AppStorePlans';
import { LockedFeature } from '@/components/LockedFeature';
import { NATIVE_PURCHASES_METHODS } from '@/services/appStorePurchases';

const API = 'http://localhost:4000';
// Deliberately not the catalog's $4.99 / $9.99, so a test can tell which
// source a rendered price came from.
const STORE_PRODUCTS = [
  {
    id: 'net.familygreenhouse.app.garden.monthly',
    displayName: 'Garden',
    description: '',
    displayPrice: '$5.49',
    price: '5.49',
  },
  {
    id: 'net.familygreenhouse.app.greenhouse.monthly',
    displayName: 'Greenhouse',
    description: '',
    displayPrice: '$10.99',
    price: '10.99',
  },
];
const NAMES = { seedling: 'Seedling', garden: 'Garden', greenhouse: 'Greenhouse' };

function renderUi(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

function signIn(role: 'admin' | 'member') {
  useAuthStore.setState({
    accessToken: 'access-1',
    user: {
      id: 'u-me',
      email: 'me@example.com',
      name: 'Sam',
      householdId: 'hh-1',
      householdRole: role,
    },
    activeHouseholdId: 'hh-1',
  });
  server.use(
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role, joinedAt: '' }])
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_APP_STORE_PURCHASES', 'true');
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    PluginHeaders: [
      { name: 'NativePurchases', methods: NATIVE_PURCHASES_METHODS.map((name) => ({ name })) },
    ],
  };
  plugin.getProducts.mockResolvedValue(STORE_PRODUCTS);
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  vi.unstubAllEnvs();
});

describe('AppStorePlans', () => {
  const seedling: SubscriptionState = { planId: 'seedling' } as SubscriptionState;

  it('offers both tiers at the App Store’s prices, with the renewal terms', async () => {
    renderUi(<AppStorePlans subscription={seedling} isAdmin planNames={NAMES} />);
    expect(await screen.findByText('$5.49 a month')).toBeInTheDocument();
    expect(screen.getByText('$10.99 a month')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe to Garden' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restore purchases' })).toBeInTheDocument();
    expect(screen.getByText(/renews automatically each month/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms of Use' })).toHaveAttribute(
      'href',
      '/legal/terms'
    );
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/legal/privacy'
    );
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\$4\.99|\$9\.99/);
    expect(text).not.toMatch(/web|browser|stripe|familygreenhouse\.net/i);
  });

  it('lets a member see the plans but not buy', async () => {
    renderUi(<AppStorePlans subscription={seedling} isAdmin={false} planNames={NAMES} />);
    expect(await screen.findByRole('button', { name: 'Subscribe to Garden' })).toBeDisabled();
    expect(screen.getByText('Only a household admin can change the plan.')).toBeInTheDocument();
  });

  it('offers no purchase to a household already paying through Stripe', async () => {
    const paying = {
      planId: 'garden',
      status: 'active',
      stripeSubscriptionId: 'sub_1',
    } as SubscriptionState;
    renderUi(<AppStorePlans subscription={paying} isAdmin planNames={NAMES} />);
    expect(await screen.findByTestId('app-store-paid-elsewhere')).toHaveTextContent(
      'This household already has a paid plan.'
    );
    expect(screen.queryByRole('button', { name: /Subscribe/ })).not.toBeInTheDocument();
  });

  it('offers only Greenhouse to a household that owns Garden outright', async () => {
    const lifetime = { planId: 'garden', lifetimePlanId: 'garden' } as SubscriptionState;
    renderUi(<AppStorePlans subscription={lifetime} isAdmin planNames={NAMES} />);
    expect(
      await screen.findByRole('button', { name: 'Subscribe to Greenhouse' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Subscribe to Garden' })).not.toBeInTheDocument();
  });

  it('shows an active App Store plan with Apple’s Manage subscription sheet', async () => {
    plugin.manageSubscriptions.mockResolvedValue(true);
    const subscribed = {
      planId: 'seedling',
      appStore: {
        planId: 'garden',
        productId: 'net.familygreenhouse.app.garden.monthly',
        expiresAt: '2026-11-24T12:00:00.000Z',
        willRenew: true,
        environment: 'Production',
        state: 'active',
      },
    } as SubscriptionState;
    renderUi(<AppStorePlans subscription={subscribed} isAdmin planNames={NAMES} />);
    expect(await screen.findByTestId('app-store-active')).toHaveTextContent(
      /Garden through the App Store\. Renews/
    );
    await userEvent.click(screen.getByRole('button', { name: 'Manage subscription' }));
    expect(plugin.manageSubscriptions).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Subscribe/ })).not.toBeInTheDocument();
  });

  it('says so when the App Store has no products to show', async () => {
    plugin.getProducts.mockResolvedValue([]);
    renderUi(<AppStorePlans subscription={seedling} isAdmin planNames={NAMES} />);
    expect(await screen.findByTestId('app-store-products-unavailable')).toBeInTheDocument();
  });
});

describe('LockedFeature in the iPhone app with App Store purchases on', () => {
  function stubReads() {
    server.use(
      http.get(`${API}/billing/plans`, () =>
        HttpResponse.json({
          paymentsAvailable: true,
          commercialHold: { active: false, effectiveDate: '2026-09-01' },
          plans: [
            { id: 'seedling', name: 'Seedling', description: '', maxPlants: 8, maxMembers: 2 },
            {
              id: 'garden',
              name: 'Garden',
              description: '',
              maxPlants: 200,
              maxMembers: null,
              monthlyPrice: 4.99,
            },
            {
              id: 'greenhouse',
              name: 'Greenhouse',
              description: '',
              maxPlants: 5000,
              maxMembers: null,
              monthlyPrice: 9.99,
            },
          ],
        })
      ),
      http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'seedling' })),
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          id: 'hh-1',
          name: 'Home',
          createdAt: '',
          createdBy: 'u-me',
          members: [{ userId: 'u-me', name: 'Sam', role: 'admin', joinedAt: '' }],
        })
      )
    );
  }

  it('sends an admin to the plans screen, naming the plan with no price', async () => {
    signIn('admin');
    stubReads();
    renderUi(<LockedFeature feature="chat" />);
    expect(await screen.findByRole('link', { name: 'See plans' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
    expect(await screen.findByTestId('locked-included')).toHaveTextContent('Garden');
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
  });

  it('tells a member an admin can change the plan, with no ask and no price', async () => {
    signIn('member');
    stubReads();
    renderUi(<LockedFeature feature="chat" />);
    expect(
      await screen.findByText('A household admin can change the plan in Settings.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
  });
});
