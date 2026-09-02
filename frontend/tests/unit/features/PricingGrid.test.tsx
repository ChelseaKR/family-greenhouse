import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PricingGrid } from '@/features/pricing/PricingGrid';
import type { PlanCatalog } from '@/services/billingService';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return { ...actual, billingService: { listPlans: vi.fn(), getCurrentSubscription: vi.fn() } };
});

const PRICED_PLANS: PlanCatalog['plans'] = [
  {
    id: 'seedling',
    name: 'Seedling',
    description: 'Free',
    maxPlants: 10,
    maxMembers: 6,
    monthlyPrice: 0,
    annualPrice: null,
    lifetimePrice: null,
  },
  {
    id: 'garden',
    name: 'Garden',
    description: 'Growing families',
    maxPlants: 500,
    maxMembers: 6,
    monthlyPrice: 4.99,
    annualPrice: 39.99,
    lifetimePrice: 149,
  },
];

async function renderGrid(catalog: PlanCatalog) {
  const { billingService } = await import('@/services/billingService');
  vi.mocked(billingService.listPlans).mockResolvedValue(catalog);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PricingGrid />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('PricingGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes the catalog when the API reports payment activity is available', async () => {
    await renderGrid({
      paymentsAvailable: true,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
      plans: PRICED_PLANS,
    });

    expect(await screen.findByText('$4.99')).toBeInTheDocument();
    // The public surface never starts a purchase: the API requires an
    // authenticated household admin, so every CTA is a link to registration.
    const cta = await screen.findByRole('link', { name: /Choose Garden/ });
    expect(cta).toHaveAttribute('href', '/register');
    expect(screen.queryByRole('button', { name: /Switch to|Buy / })).not.toBeInTheDocument();
  });

  it('falls back to the status notice when the API withholds payment activity', async () => {
    // The decisive case for a frontend deployed ahead of its backend, and for
    // any environment whose runtime gate is still shut: the build-time flag
    // says the hold is lifted, but the server is the authority and it says no.
    await renderGrid({
      paymentsAvailable: false,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
      plans: PRICED_PLANS,
    });

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /payments are temporarily unavailable/i })
      ).toBeInTheDocument();
    });
    // No amount may leak, even though the catalog it received carried them.
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    expect(screen.queryByRole('group', { name: 'Billing interval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // The hold is lifted, so the notice must not cite it or its date.
    expect(document.body.textContent).not.toMatch(/commercial hold effective/i);
  });

  it('falls back to the status notice when the catalog cannot be loaded at all', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listPlans).mockRejectedValue(new Error('network'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PricingGrid />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /payments are temporarily unavailable/i })
      ).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
  });
});
