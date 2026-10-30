import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { PricingGrid } from '@/features/pricing/PricingGrid';
import { PLAN_PRICES } from '@/features/pricing/planPrices';
import type { PlanCatalog } from '@/services/billingService';

/**
 * The dollar price is in the text a crawler (and the first paint) reads, not
 * only in the structured data and the post-fetch grid. Measured on the live
 * /pricing page on 2026-10-23: no `$` anywhere in the body text, while the
 * JSON-LD carried 4.99. The line comes from PLAN_PRICES (held equal to
 * backend/src/models/plans.ts by planPrices.test.ts) and must never outlive an
 * answer from the API that says payments are unavailable.
 */
const flags = vi.hoisted(() => ({ hold: false }));
vi.mock('@/config/commercialStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/commercialStatus')>()),
  get COMMERCIAL_HOLD_ACTIVE() {
    return flags.hold;
  },
}));
vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return { ...actual, billingService: { listPlans: vi.fn(), getCurrentSubscription: vi.fn() } };
});

const garden = PLAN_PRICES.find((plan) => plan.id === 'garden')!;
const greenhouse = PLAN_PRICES.find((plan) => plan.id === 'greenhouse')!;
const GARDEN_LINE = `$${garden.monthly.toFixed(2)} a month`;

const catalog = (overrides: Partial<PlanCatalog> = {}): PlanCatalog => ({
  paymentsAvailable: true,
  commercialHold: { active: false, effectiveDate: '2026-09-01' },
  plans: [
    {
      id: 'seedling',
      name: 'Seedling',
      description: 'Free',
      maxPlants: 20,
      maxMembers: 3,
      monthlyPrice: 0,
      annualPrice: null,
      lifetimePrice: null,
    },
    {
      id: 'garden',
      name: 'Garden',
      description: 'A household that has to coordinate',
      maxPlants: 200,
      maxMembers: null,
      monthlyPrice: 5.49,
      annualPrice: null,
      lifetimePrice: null,
    },
  ],
  ...overrides,
});

function tree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PricingGrid />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('the /pricing price is in the static text', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('en');
    await i18n.changeLanguage('en');
  });
  beforeEach(async () => {
    flags.hold = false;
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listPlans).mockReset();
  });
  afterEach(cleanup);

  it('the server-rendered markup (what the prerender writes) states both monthly prices', () => {
    const html = renderToString(tree(newClient()));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain(GARDEN_LINE);
    expect(text).toContain(`$${greenhouse.monthly.toFixed(2)} a month`);
    expect(garden.monthly).toBe(4.99); // held at the stated price; no change in this PR
  });

  it('names no annual or lifetime price while those cadences are withdrawn', () => {
    const html = renderToString(tree(newClient()));
    expect(garden.withdrawn).toEqual(expect.arrayContaining(['year', 'lifetime']));
    expect(html).not.toContain(String(garden.annual));
    expect(html).not.toContain(String(garden.lifetime));
    expect(html).not.toMatch(/year|annual|lifetime/i);
  });

  it('states no price under the commercial hold (the static build is held the same way)', () => {
    flags.hold = true;
    const html = renderToString(tree(newClient()));
    expect(html).not.toMatch(/\$\s*\d/);
    expect(html).toMatch(/payments are temporarily unavailable|paused|hold/i);
  });

  it('negative control: with the hold off the same render does contain a price', () => {
    flags.hold = false;
    expect(renderToString(tree(newClient()))).toMatch(/\$\s*\d/);
  });

  it('shows the line while the catalog is in flight and removes it when the API says unavailable', async () => {
    const { billingService } = await import('@/services/billingService');
    let settle!: (value: PlanCatalog) => void;
    vi.mocked(billingService.listPlans).mockReturnValue(
      new Promise<PlanCatalog>((resolve) => {
        settle = resolve;
      })
    );
    render(tree(newClient()));
    expect(screen.getByTestId('plan-price-line')).toHaveTextContent(GARDEN_LINE);
    settle(catalog({ paymentsAvailable: false }));
    await waitFor(() => expect(screen.queryByTestId('plan-price-line')).not.toBeInTheDocument());
    // Fail closed: the notice, and no amount anywhere, even though the response carried prices.
    expect(
      screen.getByRole('heading', { name: /payments are temporarily unavailable/i })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
  });

  it('negative control: before the API answers the line is present, so the removal above is real', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listPlans).mockReturnValue(new Promise<PlanCatalog>(() => {}));
    render(tree(newClient()));
    expect(screen.getByTestId('plan-price-line')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/\$\s*\d/);
  });

  it('removes the line and shows the notice when the catalog request fails', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listPlans).mockRejectedValue(new Error('network'));
    render(tree(newClient()));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /payments are temporarily unavailable/i })
      ).toBeInTheDocument()
    );
    expect(screen.queryByTestId('plan-price-line')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
  });

  it('when the API answers with prices, the grid shows the API amount, not the mirror', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listPlans).mockResolvedValue(catalog());
    render(tree(newClient()));
    expect(await screen.findByText('$5.49')).toBeInTheDocument(); // the response's price
    expect(screen.queryByTestId('plan-price-line')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(GARDEN_LINE);
  });
});
