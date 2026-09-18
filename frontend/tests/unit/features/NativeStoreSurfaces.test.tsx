import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { PricingPage } from '@/features/pricing/PricingPage';
import { PricingGrid } from '@/features/pricing/PricingGrid';
import { billingService } from '@/services/billingService';
import { HelpPage } from '@/features/help/HelpPage';
import { AccountDeletionPage } from '@/features/legal/AccountDeletionPage';
import { loadLegalCatalog } from '@/i18n/legalCatalog';

vi.mock('@/services/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics')>();
  return { ...actual, track: vi.fn() };
});

function renderAppAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('native store policy surfaces', () => {
  // AccountDeletionPage reads the deferred `legal.*` fragment, which App.tsx
  // normally loads inside the route's lazy() factory. Mounting the component
  // directly skips that, so register it here.
  beforeAll(async () => {
    await loadLegalCatalog();
  });

  beforeEach(() => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('replaces public checkout pricing with neutral, purchase-free plan information', () => {
    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    );
    expect(
      screen.getByRole('heading', { name: 'Your Family Greenhouse plan' })
    ).toBeInTheDocument();
    expect(screen.getByText(/No payment is collected in this app/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
    expect(screen.queryByText('$39.99')).not.toBeInTheDocument();
  });

  it('opens a signed-out native user on sign-in, not on the priced landing page', async () => {
    // The landing page embeds the live plan catalog (prices, plan buttons,
    // trial terms). It was the first screen of a signed-out store build, the
    // exact screen a reviewer sees before entering the demo credentials.
    const listPlans = vi.spyOn(billingService, 'listPlans');
    renderAppAt('/');

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    // The catalog is never even requested.
    expect(listPlans).not.toHaveBeenCalled();
    listPlans.mockRestore();
  });

  it('renders no plan grid at all, whatever the catalog says', () => {
    const listPlans = vi.spyOn(billingService, 'listPlans');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PricingGrid publishedFooter={<p>Checkout happens on the web.</p>} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(container).toBeEmptyDOMElement();
    expect(listPlans).not.toHaveBeenCalled();
    listPlans.mockRestore();
  });

  it('removes web-only billing and cancellation instructions from native help', () => {
    render(
      <MemoryRouter>
        <HelpPage />
      </MemoryRouter>
    );
    expect(screen.queryByText('Billing')).not.toBeInTheDocument();
    expect(screen.queryByText('How do I cancel my subscription?')).not.toBeInTheDocument();
  });

  it('provides a public account-deletion request path', () => {
    render(
      <MemoryRouter>
        <AccountDeletionPage />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Delete your account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to delete your account' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(screen.getByRole('link', { name: 'support@familygreenhouse.net' })).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:support@familygreenhouse.net')
    );
  });
});

describe('the website keeps its landing page', () => {
  it('renders the landing page at / for a signed-out web visitor', async () => {
    // The redirect above is native-only: without the Capacitor bridge global,
    // `/` is still the marketing page and never the sign-in form.
    renderAppAt('/');
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome back' })).not.toBeInTheDocument();
  });
});
