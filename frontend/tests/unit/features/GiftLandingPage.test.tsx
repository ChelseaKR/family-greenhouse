import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { GiftLandingPage } from '@/features/gift/GiftLandingPage';
import { useAuthStore } from '@/store/authStore';
import type { GiftPurchase, Plan, PlanCatalog } from '@/services/billingService';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual,
    billingService: {
      ...actual.billingService,
      listPlans: vi.fn(),
      createGiftCheckout: vi.fn(),
      listGiftPurchases: vi.fn(),
    },
  };
});

import { billingService } from '@/services/billingService';

const PLANS: Plan[] = [
  {
    id: 'seedling',
    name: 'Seedling',
    description: '',
    maxPlants: 20,
    maxMembers: 3,
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
];

const CATALOG: PlanCatalog = {
  paymentsAvailable: true,
  commercialHold: { active: false, effectiveDate: '2026-09-01' },
  plans: PLANS,
  giftSubscriptions: {
    minMonths: 1,
    maxMonths: 12,
    redeemWindowDays: 365,
    plans: [
      { planId: 'garden', available: true },
      { planId: 'greenhouse', available: true },
    ],
  },
};

const PURCHASE: GiftPurchase = {
  stripeSessionId: 'cs_1',
  code: 'FG-0123-4567-89AB-CDEF',
  planId: 'garden',
  months: 3,
  purchasedAt: '2026-09-13T12:00:00.000Z',
  redeemBy: '2027-09-13T12:00:00.000Z',
  status: 'unredeemed',
  redeemedAt: null,
  giftEndsAt: null,
};

function signIn(householdId: string | null = null) {
  useAuthStore.setState({
    user: {
      id: 'user-2',
      email: 'giver@example.com',
      name: 'Giver',
      householdId,
      householdRole: householdId ? 'admin' : null,
    },
    isAuthenticated: true,
  });
}

function renderPage(initialEntries: string[] = ['/gift']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <GiftLandingPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('GiftLandingPage', () => {
  const originalLocation = window.location;
  const assign = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(billingService.listPlans).mockResolvedValue(CATALOG);
    vi.mocked(billingService.listGiftPurchases).mockResolvedValue([]);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    assign.mockClear();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('is browsable with no account: a logged-out visitor gets a sign-in prompt, not a form that would only 401', async () => {
    renderPage();

    expect(await screen.findByText('Give a Family Greenhouse gift')).toBeInTheDocument();
    const signIn = screen.getByRole('link', { name: 'Sign in' });
    const register = screen.getByRole('link', { name: 'Create a free account' });
    expect(signIn).toHaveAttribute('href', '/login?redirect=%2Fgift');
    expect(register).toHaveAttribute('href', '/register?redirect=%2Fgift');
    // No purchase form, and no request for the auth-only purchase list.
    expect(screen.queryByTestId('gift-landing-purchase-form')).not.toBeInTheDocument();
    expect(billingService.listGiftPurchases).not.toHaveBeenCalled();
  });

  it('does not require a household: a signed-in buyer with none still gets the full buy form', async () => {
    signIn(null);
    renderPage();

    expect(await screen.findByTestId('gift-landing-purchase-form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Buy gift/ })).toBeInTheDocument();
  });

  it('starts checkout for the signed-in buyer and hands off to the returned Stripe URL', async () => {
    signIn(null);
    vi.mocked(billingService.createGiftCheckout).mockResolvedValue({
      url: 'https://checkout.stripe.test/gift',
    });
    renderPage();

    const buyButton = await screen.findByRole('button', { name: /Buy gift for/ });
    await userEvent.click(buyButton);

    await waitFor(() => expect(billingService.createGiftCheckout).toHaveBeenCalled());
    const call = vi.mocked(billingService.createGiftCheckout).mock.calls[0][0];
    expect(call.planId).toBe('garden');
    expect(call.months).toBe(3);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/gift'));
  });

  it('shows the returned-from-purchase notice and the buyer’s own gift codes', async () => {
    signIn(null);
    vi.mocked(billingService.listGiftPurchases).mockResolvedValue([PURCHASE]);
    renderPage(['/gift?status=success&purchase=gift']);

    expect(
      await screen.findByText(
        'Thanks — your gift code will appear here as soon as the payment is confirmed. This can take a moment.'
      )
    ).toBeInTheDocument();
    expect(await screen.findByText('FG-0123-4567-89AB-CDEF')).toBeInTheDocument();
  });

  it('is not offered in the native app', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    renderPage();

    expect(
      await screen.findByText(
        "Gifting isn't available in the app. Open familygreenhouse.net on the web to send a gift."
      )
    ).toBeInTheDocument();
    expect(billingService.listPlans).not.toHaveBeenCalled();
  });
});
