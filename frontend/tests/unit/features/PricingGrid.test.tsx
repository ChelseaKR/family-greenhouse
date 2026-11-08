import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PricingGrid } from '@/features/pricing/PricingGrid';
import { resetRememberedIntervalForTests } from '@/features/pricing/planPricing';
import type { PlanCatalog } from '@/services/billingService';

// The tapped cadence is module memory for the page load (ADR 0042, "Yearly
// first"); tests in this file share the module, so each starts forgetful.
beforeEach(() => resetRememberedIntervalForTests());

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
    monthlyPrice: 2.99,
    annualPrice: 24.99,
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

    // Yearly first (ADR 0042): the first amount on screen is the yearly one.
    expect(await screen.findByText('$24.99')).toBeInTheDocument();
    // The public surface never starts a purchase: the API requires an
    // authenticated household admin, so every CTA is a link to registration.
    const cta = await screen.findByRole('link', { name: /Choose Garden/ });
    expect(cta).toHaveAttribute('href', '/register');
    expect(screen.queryByRole('button', { name: /Switch to|Buy / })).not.toBeInTheDocument();
  });

  it('opens on Yearly with the saving hint, and keeps Monthly one tap away (ADR 0042, "Yearly first")', async () => {
    await renderGrid({
      paymentsAvailable: true,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
      plans: PRICED_PLANS,
    });
    const yearly = await screen.findByRole('button', { name: /Yearly/ });
    expect(yearly).toHaveAttribute('aria-pressed', 'true');
    expect(yearly).toHaveTextContent('Save ~30%');
    expect(screen.getByText('$24.99')).toBeInTheDocument();
    expect(screen.getAllByText('per year').length).toBeGreaterThan(0);
    expect(screen.queryByText('per month')).not.toBeInTheDocument();
    expect(screen.queryByText('$2.99')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Monthly/ }));
    expect(screen.getByRole('button', { name: /Monthly/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('$2.99')).toBeInTheDocument();
    expect(screen.queryByText('$24.99')).not.toBeInTheDocument();
  });

  it('says plainly that identification is sold as a pack and is not in Garden (ADR 0042)', async () => {
    await renderGrid({
      paymentsAvailable: true,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
      plans: PRICED_PLANS,
      identifyTopUp: { available: true, credits: 20, validityDays: 365, priceUsd: 1.99 },
    });
    expect(await screen.findByTestId('identification-note')).toHaveTextContent(
      'Plant identification is not included in Garden. It is sold as a pack of 20 identifications for $1.99.'
    );
  });

  it('names no pack price when the pack is not for sale, but still says Garden has no identification', async () => {
    await renderGrid({
      paymentsAvailable: true,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
      plans: PRICED_PLANS,
      identifyTopUp: { available: false, credits: 20, validityDays: 365 },
    });
    const note = await screen.findByTestId('identification-note');
    expect(note).toHaveTextContent('Plant identification is not included in Garden.');
    expect(note.textContent).not.toMatch(/\$/);
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

describe('PricingGrid with the withdrawn catalog', () => {
  // The shape GET /billing/plans publishes since annual and lifetime were
  // withdrawn from sale: paymentsAvailable, monthly amounts on both paid
  // tiers, and null for every other cadence. The page must read as a plain
  // monthly price list — no toggle, no unavailable tabs, no "coming back".
  const WITHDRAWN_CATALOG: PlanCatalog = {
    paymentsAvailable: true,
    commercialHold: { active: false, effectiveDate: '2026-09-01' },
    plans: [
      PRICED_PLANS[0],
      { ...PRICED_PLANS[1], annualPrice: null, lifetimePrice: null },
      {
        id: 'greenhouse',
        name: 'Greenhouse',
        description: 'Serious plant parents',
        maxPlants: 5000,
        maxMembers: 50,
        monthlyPrice: 9.99,
        annualPrice: null,
        lifetimePrice: null,
      },
    ],
  };

  it('publishes monthly prices only, with no interval toggle', async () => {
    await renderGrid(WITHDRAWN_CATALOG);

    expect(await screen.findByText('$2.99')).toBeInTheDocument();
    expect(screen.getByText('$9.99')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Billing interval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Yearly|Lifetime/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/per year|\$39\.99|\$79\.99|\$149/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not available/)).not.toBeInTheDocument();
    // The public CTA is still a link to registration for each paid tier.
    expect(screen.getByRole('link', { name: /Choose Garden/ })).toHaveAttribute(
      'href',
      '/register'
    );
    expect(screen.getByRole('link', { name: /Choose Greenhouse/ })).toHaveAttribute(
      'href',
      '/register'
    );
  });
});
