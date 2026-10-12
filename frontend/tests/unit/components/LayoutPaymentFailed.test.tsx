import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Layout } from '@/components/Layout';
import { useAuthStore } from '@/store/authStore';
import * as householdService from '@/services/householdService';
import { billingService, type SubscriptionState } from '@/services/billingService';

vi.mock('@/services/analytics', () => ({
  track: vi.fn(),
  setActiveHousehold: vi.fn(),
  identify: vi.fn(),
  setTelemetryAuthToken: vi.fn(),
  reset: vi.fn(),
}));

/**
 * #593: a declined card drops the household to lower caps at once, and before
 * this the only place in the app that said so was Settings → Plan status. The
 * frame now carries the notice on every screen — which is only useful if it
 * appears on the screens people actually use (the dashboard, the add-plant
 * form that returns the 402) and stays off the one page that already says it.
 */

function renderFrameAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<div>dashboard body</div>} />
            <Route path="/plants/new" element={<div>add plant body</div>} />
            <Route path="/settings/billing" element={<div>billing body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function subscriptionIs(sub: SubscriptionState) {
  vi.spyOn(billingService, 'getCurrentSubscription').mockResolvedValue(sub);
  vi.spyOn(billingService, 'listPlans').mockResolvedValue({
    paymentsAvailable: true,
    commercialHold: { active: false, effectiveDate: '2026-09-01' },
    plans: [
      { id: 'seedling', name: 'Seedling', description: '', maxPlants: 20, maxMembers: 3 },
      { id: 'garden', name: 'Garden', description: '', maxPlants: 200, maxMembers: null },
    ] as never,
  });
}

const pastDue: SubscriptionState = {
  planId: 'garden',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  status: 'past_due',
};

describe('the app frame when a payment has failed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(householdService, 'listMyHouseholds').mockResolvedValue([
      { householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' },
    ]);
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'someone@example.invalid',
        name: 'Someone',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
      idToken: 'id-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      isAuthenticated: true,
      isLoading: false,
      activeHouseholdId: null,
    });
  });

  it.each(['/dashboard', '/plants/new'])(
    'shows the retrying banner above %s, saying the plan is kept',
    async (path) => {
      subscriptionIs(pastDue);
      renderFrameAt(path);

      expect(await screen.findByTestId('payment-failed-banner')).toHaveAttribute(
        'data-stage',
        'retrying'
      );
      expect(screen.getByText('Your last payment didn’t go through')).toBeInTheDocument();
      expect(await screen.findByText(/keeps the Garden plan/)).toBeInTheDocument();
    }
  );

  it('shows the lapsed banner once Stripe has given up', async () => {
    subscriptionIs({ ...pastDue, status: 'unpaid' });
    renderFrameAt('/plants/new');

    expect(await screen.findByTestId('payment-failed-banner')).toHaveAttribute(
      'data-stage',
      'lapsed'
    );
    expect(screen.getByText('We couldn’t take your last payment')).toBeInTheDocument();
  });

  it('stays off Settings → Plan status, which carries the full notice itself', async () => {
    subscriptionIs(pastDue);
    renderFrameAt('/settings/billing');

    expect(await screen.findByText('billing body')).toBeInTheDocument();
    // Let the subscription read settle before asserting absence, or this
    // passes against a read that simply has not landed yet.
    await vi.waitFor(() => expect(billingService.getCurrentSubscription).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('payment-failed-banner')).not.toBeInTheDocument();
  });

  it('shows nothing for a household in good standing', async () => {
    subscriptionIs({ ...pastDue, status: 'active' });
    renderFrameAt('/dashboard');

    expect(await screen.findByText('dashboard body')).toBeInTheDocument();
    await vi.waitFor(() => expect(billingService.getCurrentSubscription).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('payment-failed-banner')).not.toBeInTheDocument();
  });
});
