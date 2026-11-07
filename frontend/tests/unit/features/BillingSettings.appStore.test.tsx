/**
 * Settings → Plan and Apple In-App Purchase (ADR 0041), from both sides:
 * inside the iPhone app with purchases on, the App Store card replaces the
 * neutral "not available in the app" line; with purchases off (the default)
 * nothing changes; on the website a household paying Apple is told where its
 * plan is managed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Plan, SubscriptionState } from '@/services/billingService';
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

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual,
    billingService: {
      listPlans: vi.fn(),
      getCurrentSubscription: vi.fn(),
      createCheckout: vi.fn(),
      createPortalSession: vi.fn(),
      createTopUpCheckout: vi.fn(),
    },
  };
});
vi.mock('@/hooks/useActiveHouseholdId', () => ({ useActiveHouseholdId: () => 'hh-1' }));
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => true,
  useActiveHouseholdRole: () => 'admin',
}));

import { BillingSettings } from '@/features/settings/BillingSettings';
import { NATIVE_PURCHASES_METHODS } from '@/services/appStorePurchases';

const PLANS: Plan[] = [
  {
    id: 'seedling',
    name: 'Seedling',
    description: '',
    maxPlants: 8,
    maxMembers: 2,
    monthlyPrice: 0,
  },
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
] as Plan[];

async function renderBilling(sub: SubscriptionState) {
  const { billingService } = await import('@/services/billingService');
  vi.mocked(billingService.listPlans).mockResolvedValue({
    paymentsAvailable: true,
    commercialHold: { active: false, effectiveDate: '2026-09-01' },
    plans: PLANS,
  });
  vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(sub);
  useAuthStore.setState({
    user: { id: 'u-1', email: 'a@b.com', name: 'A', householdId: 'hh-1', householdRole: 'admin' },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings/billing']}>
        <BillingSettings />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await screen.findAllByText(/Your household is (on the|trying)/);
}

function pretendIosApp() {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    PluginHeaders: [
      { name: 'NativePurchases', methods: NATIVE_PURCHASES_METHODS.map((name) => ({ name })) },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  plugin.getProducts.mockResolvedValue([
    {
      id: 'net.familygreenhouse.app.garden.monthly',
      displayName: 'Garden',
      description: '',
      displayPrice: '$5.49',
      price: '5.49',
    },
  ]);
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  vi.unstubAllEnvs();
});

describe('BillingSettings and the App Store', () => {
  it('in the iPhone app with purchases on, shows the App Store card instead of the neutral line', async () => {
    vi.stubEnv('VITE_APP_STORE_PURCHASES', 'true');
    pretendIosApp();
    await renderBilling({ planId: 'seedling' } as SubscriptionState);
    expect(await screen.findByText('$5.49 a month')).toBeInTheDocument();
    expect(screen.queryByText("Plan changes aren't available in the app.")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$4\.99|\$9\.99/);
  });

  it('in the iPhone app with purchases off (the default), keeps the neutral line and no purchase', async () => {
    pretendIosApp();
    await renderBilling({ planId: 'seedling' } as SubscriptionState);
    expect(screen.getByText("Plan changes aren't available in the app.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Subscribe/ })).not.toBeInTheDocument();
    expect(plugin.getProducts).not.toHaveBeenCalled();
  });

  it('on the website, tells a household paying Apple where its plan is managed', async () => {
    await renderBilling({
      planId: 'seedling',
      appStore: {
        planId: 'garden',
        productId: 'net.familygreenhouse.app.garden.monthly',
        expiresAt: '2999-01-01T00:00:00.000Z',
        environment: 'Production',
        state: 'active',
      },
    } as SubscriptionState);
    expect(screen.getByTestId('billed-by-app-store')).toHaveTextContent(
      'Garden is billed through the App Store.'
    );
  });
});
