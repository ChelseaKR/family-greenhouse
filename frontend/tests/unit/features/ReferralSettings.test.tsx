import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { ReferralSettings } from '@/features/settings/ReferralSettings';
import { server } from '../../msw/server';

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

const API = 'http://localhost:4000';

const STATUS = {
  code: 'RF-00000-00001',
  bonusPlanId: 'garden',
  bonusMonths: 1,
  totalReferrals: 2,
  grantedReferrals: 1,
  referrals: [
    { signedUpAt: '2026-09-10T00:00:00.000Z', rewarded: true },
    { signedUpAt: '2026-09-12T00:00:00.000Z', rewarded: false },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ReferralSettings />
    </QueryClientProvider>
  );
}

describe('ReferralSettings', () => {
  it('shows the referral link built from the code, and the stats summary', async () => {
    server.use(http.get(`${API}/me/referral`, () => HttpResponse.json(STATUS)));
    renderPage();
    const input = (await screen.findByTestId('referral-link-input')) as HTMLInputElement;
    expect(input.value).toBe('http://localhost:3000/register?ref=RF-00000-00001');
    expect(await screen.findByText('1 of 2 earned a bonus')).toBeInTheDocument();
    const rows = await screen.findAllByTestId('referral-row');
    expect(rows).toHaveLength(2);
  });

  it('shows the empty state when nobody has signed up yet', async () => {
    server.use(
      http.get(`${API}/me/referral`, () =>
        HttpResponse.json({ ...STATUS, totalReferrals: 0, grantedReferrals: 0, referrals: [] })
      )
    );
    renderPage();
    expect(
      await screen.findByText(/No signups yet\. Once someone joins using your link/i)
    ).toBeInTheDocument();
  });

  it('reports a failed read honestly rather than as zero referrals (ADR 0010)', async () => {
    server.use(http.get(`${API}/me/referral`, () => new HttpResponse(null, { status: 500 })));
    renderPage();
    expect(await screen.findByText(/Couldn't load your referral info/i)).toBeInTheDocument();
    expect(screen.queryByTestId('referral-link-input')).not.toBeInTheDocument();
  });

  // --- The IAP-safety check this feature specifically owes PR #794. ---
  describe('inside the native (Capacitor) shell', () => {
    beforeEach(() => {
      // Same global the Capacitor bridge injects, same pattern
      // AddPlantPage.test.tsx and BillingSettings.test.tsx use.
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });

    afterEach(() => {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    });

    it("links to the public site, not the app's own origin", async () => {
      // The shells' page origin is capacitor://localhost (iOS) or
      // https://localhost (Android); a link built from it opens nothing for
      // the person it is sent to.
      server.use(http.get(`${API}/me/referral`, () => HttpResponse.json(STATUS)));
      renderPage();
      const input = (await screen.findByTestId('referral-link-input')) as HTMLInputElement;
      expect(input.value).toBe('https://familygreenhouse.net/register?ref=RF-00000-00001');
    });

    it('still renders the link — this page is intentionally NOT hidden on native (nothing here is a purchase)', async () => {
      server.use(http.get(`${API}/me/referral`, () => HttpResponse.json(STATUS)));
      renderPage();
      expect(await screen.findByTestId('referral-link-input')).toBeInTheDocument();
    });

    it('never renders a purchase-adjacent control, on native or web', async () => {
      server.use(http.get(`${API}/me/referral`, () => HttpResponse.json(STATUS)));
      renderPage();
      await screen.findByTestId('referral-link-input');
      // Nothing that looks like a checkout entry point: no price, no "Buy",
      // "Upgrade", "Switch to a plan", or "Manage plan" control — the whole
      // vocabulary BillingSettings/PricingPage/GiftLandingPage use for their
      // real Stripe-Checkout buttons. Only Copy is a button here.
      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveTextContent(/copy link/i);
      expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /buy|upgrade|switch to|manage plan/i })
      ).toBeNull();
    });
  });
});
