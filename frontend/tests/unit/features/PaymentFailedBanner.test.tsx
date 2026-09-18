import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { useState, type ReactNode } from 'react';
import es from '@/i18n/locales/es/translation.json';
import { PaymentFailedBanner } from '@/features/billing/PaymentFailedBanner';
import type { Plan, PlanCatalog, SubscriptionState } from '@/services/billingService';

const isAdmin = vi.fn(() => true);
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => isAdmin(),
  useActiveHouseholdRole: () => (isAdmin() ? 'admin' : 'member'),
}));

const listPlans = vi.fn<() => Promise<PlanCatalog>>();
vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return { ...actual, billingService: { listPlans: () => listPlans() } };
});

const CATALOG: PlanCatalog = {
  paymentsAvailable: true,
  commercialHold: { active: false, effectiveDate: '2026-09-01' },
  plans: [
    { id: 'seedling', name: 'Seedling', description: '', maxPlants: 20, maxMembers: 3 },
    { id: 'garden', name: 'Garden', description: '', maxPlants: 200, maxMembers: null },
    { id: 'greenhouse', name: 'Greenhouse', description: '', maxPlants: 5000, maxMembers: null },
  ] as unknown as Plan[],
};

/** Stripe is still retrying: the household keeps Garden (#593). */
const retrying: SubscriptionState = {
  planId: 'garden',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  status: 'past_due',
};

/** Stripe gave up: the caps have dropped. */
const lapsed: SubscriptionState = { ...retrying, status: 'unpaid' };

function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderBanner(subscription: SubscriptionState | null | undefined) {
  return render(
    <Providers>
      <PaymentFailedBanner subscription={subscription} />
    </Providers>
  );
}

describe('PaymentFailedBanner', () => {
  beforeEach(() => {
    isAdmin.mockReturnValue(true);
    listPlans.mockReset();
    listPlans.mockResolvedValue(CATALOG);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  describe('while Stripe retries (past_due) — access is kept', () => {
    it('says the plan is kept, names it, and asks for the card before retries run out', async () => {
      renderBanner(retrying);

      expect(screen.getByText('Your last payment didn’t go through')).toBeInTheDocument();
      expect(
        await screen.findByText(/your household keeps the Garden plan and everything it includes/)
      ).toBeInTheDocument();
      expect(screen.getByText(/nothing has changed yet/)).toBeInTheDocument();
      expect(screen.getByText(/avoid losing Garden if the retries run out/)).toBeInTheDocument();
      expect(screen.getByTestId('payment-failed-banner')).toHaveAttribute('data-stage', 'retrying');
      expect(
        screen.getByRole('link', { name: 'Update the card in Settings → Plan status' })
      ).toHaveAttribute('href', '/settings/billing');
    });

    it('never says anything was taken away while access is kept', async () => {
      renderBanner(retrying);
      await screen.findByText(/keeps the Garden plan/);
      const text = document.body.textContent ?? '';
      // The lapsed-stage claims, none of which is true during the retries.
      expect(text).not.toMatch(/Seedling/);
      expect(text).not.toMatch(/capped/);
      expect(text).not.toMatch(/limits rather than/);
      expect(text).not.toMatch(/We couldn’t take your last payment/);
    });

    it('names no plan, rather than a guessed one, while the catalog has not answered', () => {
      listPlans.mockReturnValue(new Promise(() => {}));
      renderBanner(retrying);
      expect(
        screen.getByText(/keeps its paid plan and everything it includes/)
      ).toBeInTheDocument();
    });
  });

  describe('once Stripe gives up — the caps have dropped', () => {
    it.each(['unpaid', 'incomplete', 'incomplete_expired'])(
      'says so for %s, with the free plan named',
      (status) => {
        renderBanner({ ...lapsed, status });
        expect(screen.getByText('We couldn’t take your last payment')).toBeInTheDocument();
        expect(screen.getByText(/free Seedling plan’s limits/)).toBeInTheDocument();
        expect(screen.getByText(/nothing is deleted/)).toBeInTheDocument();
        expect(screen.getByTestId('payment-failed-banner')).toHaveAttribute('data-stage', 'lapsed');
        // The catalog is only read to name a KEPT plan; nothing to name here.
        expect(listPlans).not.toHaveBeenCalled();
      }
    );

    it('does not name the free plan when a tier bought outright is the floor', () => {
      renderBanner({ ...lapsed, planId: 'greenhouse', lifetimePlanId: 'garden' });
      expect(screen.queryByText(/free Seedling plan/)).not.toBeInTheDocument();
      expect(
        screen.getByText(/the plan it already owns outright or was given/)
      ).toBeInTheDocument();
    });
  });

  it.each([
    ['active', 'active'],
    ['trialing', 'trialing'],
    ['canceled', 'canceled'],
    ['paused', 'paused'],
    ['an absent status', undefined],
  ])('renders nothing for %s', (_label, status) => {
    const { container } = renderBanner({ ...retrying, status });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the subscription has been read', () => {
    expect(renderBanner(undefined).container).toBeEmptyDOMElement();
    cleanup();
    expect(renderBanner(null).container).toBeEmptyDOMElement();
  });

  it('disappears once the household pays, from either stage, with no dismiss state', async () => {
    for (const failing of [retrying, lapsed]) {
      const { rerender } = renderBanner(failing);
      expect(screen.getByTestId('payment-failed-banner')).toBeInTheDocument();
      rerender(
        <Providers>
          <PaymentFailedBanner subscription={{ ...failing, status: 'active' }} />
        </Providers>
      );
      expect(screen.queryByTestId('payment-failed-banner')).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('tells a member only an admin can fix it, and does not offer them the card', () => {
    isAdmin.mockReturnValue(false);
    renderBanner(lapsed);

    expect(screen.getByText('Only a household admin can manage billing.')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Update the card in Settings → Plan status' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'See the details in Settings → Plan status' })
    ).toHaveAttribute('href', '/settings/billing');
  });

  describe('inside the native (Capacitor) shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });

    it.each([
      ['retrying', retrying],
      ['lapsed', lapsed],
    ])('points only at the in-app page while %s, never at a payment step', (_stage, sub) => {
      renderBanner(sub);
      expect(
        screen.queryByRole('link', { name: 'Update the card in Settings → Plan status' })
      ).not.toBeInTheDocument();
      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute('href', '/settings/billing');
      expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    });
  });
});

describe('PaymentFailedBanner under es', () => {
  let spanish: I18nInstance;

  beforeAll(async () => {
    spanish = createInstance();
    await spanish.init({
      lng: 'es',
      fallbackLng: 'es',
      resources: { es: { translation: es } },
      interpolation: { escapeValue: false },
    });
  });

  beforeEach(() => {
    isAdmin.mockReturnValue(true);
    listPlans.mockReset();
    listPlans.mockResolvedValue(CATALOG);
  });

  afterEach(() => cleanup());

  function renderSpanish(subscription: SubscriptionState) {
    return render(
      <I18nextProvider i18n={spanish}>
        <Providers>
          <PaymentFailedBanner subscription={subscription} />
        </Providers>
      </I18nextProvider>
    );
  }

  it('renders the retrying stage in Spanish, with the kept plan named', async () => {
    renderSpanish(retrying);
    expect(screen.getByText('Tu último pago no se ha completado')).toBeInTheDocument();
    expect(await screen.findByText(/tu hogar conserva el plan Garden/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Actualiza la tarjeta en Ajustes → Estado del plan' })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/settings\.billing\./);
    expect(document.body.textContent).not.toMatch(/Plántula/);
  });

  it('renders both lapsed wordings in Spanish', () => {
    const { rerender } = renderSpanish(lapsed);
    expect(screen.getByText('No hemos podido cobrar tu último pago')).toBeInTheDocument();
    expect(screen.getByText(/plan gratuito Plántula/)).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={spanish}>
        <Providers>
          <PaymentFailedBanner subscription={{ ...lapsed, lifetimePlanId: 'garden' }} />
        </Providers>
      </I18nextProvider>
    );
    expect(screen.getByText(/ya compró de por vida o que recibió como regalo/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/settings\.billing\./);
    expect(screen.queryByText(/We couldn’t take/)).not.toBeInTheDocument();
  });
});
