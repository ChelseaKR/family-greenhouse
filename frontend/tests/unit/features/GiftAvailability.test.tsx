import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Footer } from '@/components/Footer';
import { LandingPage } from '@/features/landing/LandingPage';
import { PricingPage } from '@/features/pricing/PricingPage';
import type { Plan, PlanCatalog } from '@/services/billingService';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual,
    billingService: { ...actual.billingService, listPlans: vi.fn() },
  };
});

import { billingService } from '@/services/billingService';

const PLANS: Plan[] = [
  { id: 'seedling', name: 'Seedling', description: '', maxPlants: 20, maxMembers: 3 },
  { id: 'garden', name: 'Garden', description: '', maxPlants: 200, maxMembers: null },
];

/** The catalog the API publishes when `STRIPE_PRICE_ID_GIFT_*` are set (or not). */
function catalog(giftAvailable: boolean): PlanCatalog {
  return {
    paymentsAvailable: true,
    commercialHold: { active: false, effectiveDate: '2026-09-01' },
    plans: PLANS,
    giftSubscriptions: {
      minMonths: 1,
      maxMonths: 12,
      redeemWindowDays: 365,
      plans: [
        { planId: 'garden', available: giftAvailable },
        { planId: 'greenhouse', available: giftAvailable },
      ],
    },
  };
}

function renderIn(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

const giftLinks = () => screen.queryAllByRole('link', { name: 'Gift a subscription' });

const SURFACES: Array<[string, () => React.ReactNode]> = [
  ['the footer', () => <Footer />],
  ['the landing page header and footer', () => <LandingPage />],
  ['the pricing page note', () => <PricingPage />],
];

describe.each(SURFACES)('the Gift link on %s', (_name, surface) => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('is shown while the API says a gift can be bought', async () => {
    vi.mocked(billingService.listPlans).mockResolvedValue(catalog(true));
    renderIn(surface());
    await waitFor(() => expect(giftLinks().length).toBeGreaterThan(0));
    for (const link of giftLinks()) expect(link).toHaveAttribute('href', '/gift');
  });

  it('is hidden when no gift price id is configured (negative control: same page, link present when configured)', async () => {
    const configured = catalog(true);
    const unset = catalog(false);
    // The sabotage must have changed what the page is given.
    expect(unset.giftSubscriptions?.plans.some((p) => p.available)).toBe(false);
    expect(configured.giftSubscriptions?.plans.some((p) => p.available)).toBe(true);

    vi.mocked(billingService.listPlans).mockResolvedValue(unset);
    renderIn(surface());
    await waitFor(() => expect(billingService.listPlans).toHaveBeenCalled());
    // Give the query time to settle, then assert absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(giftLinks()).toHaveLength(0);
  });

  it('is hidden when the catalog cannot be read', async () => {
    vi.mocked(billingService.listPlans).mockRejectedValue(new Error('network'));
    renderIn(surface());
    await waitFor(() => expect(billingService.listPlans).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(giftLinks()).toHaveLength(0);
  });

  it('is hidden when the API predates gifts and publishes no offer', async () => {
    const { giftSubscriptions: _gone, ...noOffer } = catalog(true);
    vi.mocked(billingService.listPlans).mockResolvedValue(noOffer);
    renderIn(surface());
    await waitFor(() => expect(billingService.listPlans).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(giftLinks()).toHaveLength(0);
  });
});
