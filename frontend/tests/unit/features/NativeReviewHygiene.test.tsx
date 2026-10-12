/**
 * App Review hygiene for the iOS and Android apps (owner decisions
 * 2026-10-02), each held from both sides: inside the shells there is no path
 * toward buying outside In-App Purchase (Guideline 3.1.1), and the website,
 * which takes real payments, keeps every one of those paths unchanged.
 *
 *  - /pricing and /gift open Settings → Plan status in the apps.
 *  - The public footer and header link to neither in the apps.
 *  - The memorial line lives only on Settings → About in the apps; the
 *    website keeps it on every page and has no About section.
 *
 * The shells are simulated the way the Capacitor bridge announces itself:
 * `window.Capacitor`, which lib/platform.ts reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '@/App';
import { PricingPage } from '@/features/pricing/PricingPage';
import { GiftLandingPage } from '@/features/gift/GiftLandingPage';
import { Footer } from '@/components/Footer';
import { PublicShell } from '@/components/PublicShell';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { billingService } from '@/services/billingService';

vi.mock('@/services/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics')>();
  return { ...actual, track: vi.fn() };
});
// Every settings panel but About is stubbed: these tests are about which
// sections exist, and the real panels need a household and a plan catalog.
vi.mock('@/features/settings/BillingSettings', () => ({ BillingSettings: () => <div /> }));
vi.mock('@/features/settings/NotificationSettings', () => ({
  NotificationSettings: () => <div />,
}));
vi.mock('@/features/settings/PreferencesSettings', () => ({
  PreferencesSettings: () => <div data-testid="preferences-panel" />,
}));
vi.mock('@/features/settings/ApiKeysSettings', () => ({ ApiKeysSettings: () => <div /> }));
vi.mock('@/features/settings/KioskSettings', () => ({ KioskSettings: () => <div /> }));
vi.mock('@/features/settings/HouseholdChannelSettings', () => ({
  HouseholdChannelSettings: () => <div />,
}));
vi.mock('@/features/settings/AccountSettings', () => ({ AccountSettings: () => <div /> }));
vi.mock('@/features/tags/TagPinSettings', () => ({ TagPinSettings: () => <div /> }));

const MEMORIAL = 'In loving memory of my mom, Joyce — who taught us to keep growing.';

function pretendToBeTheIosShell() {
  // CapacitorCustomPlatform keeps the global saying "ios" after
  // @capacitor/core loads (the full App does load it) and rebuilds it, as in
  // tests/e2e/native-photo-buttons.spec.ts.
  (window as unknown as Record<string, unknown>).CapacitorCustomPlatform = {
    name: 'ios',
    plugins: {},
  };
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
  };
}

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  delete (window as unknown as Record<string, unknown>).CapacitorCustomPlatform;
});

function withQueries(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

/** /pricing and /gift beside a stand-in Plan status page. */
function renderPurchaseRoute(path: '/pricing' | '/gift') {
  return render(
    withQueries(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/gift" element={<GiftLandingPage />} />
          <Route path="/settings/billing" element={<h1>Plan status stand-in</h1>} />
        </Routes>
      </MemoryRouter>
    )
  );
}

function footerHrefs() {
  return Array.from(document.querySelectorAll('footer nav a')).map((a) => a.getAttribute('href'));
}

describe('inside the iOS app', () => {
  it.each(['/pricing', '/gift'] as const)('%s opens Settings → Plan status', async (path) => {
    pretendToBeTheIosShell();
    const listPlans = vi.spyOn(billingService, 'listPlans');
    renderPurchaseRoute(path);

    expect(
      await screen.findByRole('heading', { name: 'Plan status stand-in' })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    expect(document.body.textContent).not.toMatch(/on the web|gift/i);
    // The plan catalog (with its prices) is never even requested.
    expect(listPlans).not.toHaveBeenCalled();
    listPlans.mockRestore();
  });

  it('/pricing, signed out, lands on sign-in through the real routes', async () => {
    pretendToBeTheIosShell();
    render(
      withQueries(
        <MemoryRouter initialEntries={['/pricing']}>
          <App />
        </MemoryRouter>
      )
    );
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
  });

  it('the public footer links to neither plans nor gifts, and has no memorial line', () => {
    pretendToBeTheIosShell();
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    const hrefs = footerHrefs();
    expect(hrefs).not.toContain('/pricing');
    expect(hrefs).not.toContain('/gift');
    // The rest of the footer is untouched: Privacy and Terms are still there.
    expect(hrefs).toContain('/legal/privacy');
    expect(hrefs).toContain('/legal/terms');
    expect(screen.queryByText(MEMORIAL)).not.toBeInTheDocument();
  });

  it('the public header offers no plans page', () => {
    pretendToBeTheIosShell();
    render(
      <MemoryRouter>
        <PublicShell>
          <p>body</p>
        </PublicShell>
      </MemoryRouter>
    );
    expect(document.querySelector('a[href="/pricing"]')).toBeNull();
    expect(document.querySelector('a[href="/gift"]')).toBeNull();
  });

  it('Settings has an About section, last, and it carries the memorial line', () => {
    pretendToBeTheIosShell();
    render(
      <MemoryRouter initialEntries={['/settings?section=about']}>
        <SettingsPage />
      </MemoryRouter>
    );
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs[tabs.length - 1]).toBe('About');
    expect(screen.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(MEMORIAL)).toBeInTheDocument();
  });
});

describe('on the website (unchanged)', () => {
  it('/pricing is the plans page and links to gifts', async () => {
    renderPurchaseRoute('/pricing');
    expect(screen.queryByRole('heading', { name: 'Plan status stand-in' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('/gift is the gift page, not a redirect', () => {
    renderPurchaseRoute('/gift');
    expect(screen.queryByRole('heading', { name: 'Plan status stand-in' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('the public footer still links to plans and gifts, with the memorial line', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    const hrefs = footerHrefs();
    expect(hrefs).toContain('/pricing');
    expect(hrefs).toContain('/gift');
    expect(screen.getByText(MEMORIAL)).toBeInTheDocument();
  });

  it('the public header still offers the plans page', () => {
    render(
      <MemoryRouter>
        <PublicShell>
          <p>body</p>
        </PublicShell>
      </MemoryRouter>
    );
    expect(document.querySelectorAll('a[href="/pricing"]').length).toBeGreaterThan(0);
  });

  it('Settings has no About section, and ?section=about falls back to Preferences', () => {
    render(
      <MemoryRouter initialEntries={['/settings?section=about']}>
        <SettingsPage />
      </MemoryRouter>
    );
    expect(screen.queryByRole('tab', { name: 'About' })).not.toBeInTheDocument();
    expect(screen.getByTestId('preferences-panel')).toBeInTheDocument();
    expect(screen.queryByText(MEMORIAL)).not.toBeInTheDocument();
  });
});
