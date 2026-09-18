import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import es from '@/i18n/locales/es/translation.json';
import { PaymentFailedBanner } from '@/features/billing/PaymentFailedBanner';
import type { SubscriptionState } from '@/services/billingService';

const isAdmin = vi.fn(() => true);
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => isAdmin(),
  useActiveHouseholdRole: () => (isAdmin() ? 'admin' : 'member'),
}));

const pastDue: SubscriptionState = {
  planId: 'garden',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  status: 'past_due',
};

function renderBanner(subscription: SubscriptionState | null | undefined) {
  return render(
    <MemoryRouter>
      <PaymentFailedBanner subscription={subscription} />
    </MemoryRouter>
  );
}

describe('PaymentFailedBanner', () => {
  beforeEach(() => {
    isAdmin.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('tells an admin the payment failed, what changed, and where to fix it', () => {
    renderBanner(pastDue);

    expect(screen.getByText('We couldn’t take your last payment')).toBeInTheDocument();
    // What changed — the caps, and that nothing is deleted.
    expect(screen.getByText(/free Seedling plan’s limits/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is deleted/)).toBeInTheDocument();
    // How to fix it: an in-app link to the page that holds the portal button.
    const link = screen.getByRole('link', { name: 'Update the card in Settings → Plan status' });
    expect(link).toHaveAttribute('href', '/settings/billing');
  });

  it.each(['past_due', 'unpaid', 'incomplete', 'incomplete_expired'])(
    'shows for the unpaid status %s',
    (status) => {
      renderBanner({ ...pastDue, status });
      expect(screen.getByTestId('payment-failed-banner')).toBeInTheDocument();
    }
  );

  it.each([
    ['active', 'active'],
    ['trialing', 'trialing'],
    ['canceled', 'canceled'],
    ['paused', 'paused'],
    ['an absent status', undefined],
  ])('renders nothing for %s', (_label, status) => {
    const { container } = renderBanner({ ...pastDue, status });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the subscription has been read', () => {
    expect(renderBanner(undefined).container).toBeEmptyDOMElement();
    cleanup();
    expect(renderBanner(null).container).toBeEmptyDOMElement();
  });

  it('disappears once the household pays, with no dismiss state left behind', () => {
    // Stripe sends past_due -> active when the card goes through; the webhook
    // writes it and the shared subscription read re-renders the frame.
    const { rerender } = renderBanner(pastDue);
    expect(screen.getByTestId('payment-failed-banner')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <PaymentFailedBanner subscription={{ ...pastDue, status: 'active' }} />
      </MemoryRouter>
    );
    expect(screen.queryByTestId('payment-failed-banner')).not.toBeInTheDocument();
    expect(screen.queryByText('We couldn’t take your last payment')).not.toBeInTheDocument();
  });

  it('tells a member only an admin can fix it, and does not offer them the card', () => {
    isAdmin.mockReturnValue(false);
    renderBanner(pastDue);

    expect(screen.getByText('Only a household admin can manage billing.')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Update the card in Settings → Plan status' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'See the details in Settings → Plan status' })
    ).toHaveAttribute('href', '/settings/billing');
  });

  it('does not name the free plan when a tier bought outright is the floor', () => {
    renderBanner({ ...pastDue, planId: 'greenhouse', lifetimePlanId: 'garden' });

    expect(screen.queryByText(/free Seedling plan/)).not.toBeInTheDocument();
    expect(screen.getByText(/the plan it already owns outright or was given/)).toBeInTheDocument();
  });

  describe('inside the native (Capacitor) shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });

    it('states the failure but points only at the in-app page, never at a payment step', () => {
      renderBanner(pastDue);

      expect(screen.getByText('We couldn’t take your last payment')).toBeInTheDocument();
      // Guideline 3.1.1: no call to action toward an outside payment
      // mechanism. The one link is the in-app, native-gated billing page.
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

  afterEach(() => cleanup());

  it('renders every line in Spanish, for both the Seedling and the owned-floor wording', () => {
    isAdmin.mockReturnValue(true);
    const { rerender } = render(
      <I18nextProvider i18n={spanish}>
        <MemoryRouter>
          <PaymentFailedBanner subscription={pastDue} />
        </MemoryRouter>
      </I18nextProvider>
    );
    expect(screen.getByText('No hemos podido cobrar tu último pago')).toBeInTheDocument();
    expect(screen.getByText(/plan gratuito Plántula/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Actualiza la tarjeta en Ajustes → Estado del plan' })
    ).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={spanish}>
        <MemoryRouter>
          <PaymentFailedBanner subscription={{ ...pastDue, lifetimePlanId: 'garden' }} />
        </MemoryRouter>
      </I18nextProvider>
    );
    expect(screen.getByText(/ya compró de por vida o que recibió como regalo/)).toBeInTheDocument();
    // No raw key and no English left behind.
    expect(document.body.textContent).not.toMatch(/settings\.billing\./);
    expect(screen.queryByText(/We couldn’t take/)).not.toBeInTheDocument();
  });
});
