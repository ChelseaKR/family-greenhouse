import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BillingSettings } from '@/features/settings/BillingSettings';
import {
  isOverPlanLimit,
  type Plan,
  type PlanUsage,
  type SubscriptionState,
} from '@/services/billingService';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual, // keep isOverPlanLimit (the real over-limit calc) and types
    billingService: {
      listPlans: vi.fn(),
      getCurrentSubscription: vi.fn(),
      startCheckout: vi.fn(),
      openPortal: vi.fn(),
    },
  };
});

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

const PLANS: Plan[] = [
  {
    id: 'seedling',
    name: 'Seedling',
    description: 'Free',
    maxPlants: 10,
    maxMembers: 1,
  },
  {
    id: 'garden',
    name: 'Garden',
    description: 'Families',
    maxPlants: 500,
    maxMembers: 6,
  },
  {
    id: 'greenhouse',
    name: 'Greenhouse',
    description: 'Serious',
    maxPlants: 5000,
    maxMembers: 50,
  },
];

function usage(over: Partial<PlanUsage> = {}): PlanUsage {
  return { plantCount: 4, maxPlants: 10, memberCount: 1, maxMembers: 1, ...over };
}

async function renderBilling(sub: SubscriptionState) {
  const { billingService } = await import('@/services/billingService');
  vi.mocked(billingService.listPlans).mockResolvedValue({
    paymentsAvailable: false,
    commercialHold: { active: true, effectiveDate: '2026-07-14' },
    plans: PLANS,
  });
  vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(sub);
  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'a@b.com',
      name: 'A',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BillingSettings />
      </MemoryRouter>
    </QueryClientProvider>
  );
  // Wait for the queries to settle (the plan blurb gives way to content).
  await screen.findByText(/Your household is on the/);
}

describe('isOverPlanLimit (over-limit calc)', () => {
  it('is false with no usage data (older backend / loading)', () => {
    expect(isOverPlanLimit(undefined)).toBe(false);
    expect(isOverPlanLimit(null)).toBe(false);
  });

  it('is false at or under the caps (boundary: exactly at cap is NOT over)', () => {
    expect(isOverPlanLimit(usage())).toBe(false);
    expect(isOverPlanLimit(usage({ plantCount: 10 }))).toBe(false);
    expect(isOverPlanLimit(usage({ memberCount: 1 }))).toBe(false);
  });

  it('is true when either plants or members exceed the cap', () => {
    expect(isOverPlanLimit(usage({ plantCount: 11 }))).toBe(true);
    expect(isOverPlanLimit(usage({ memberCount: 2 }))).toBe(true);
  });
});

describe('BillingSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows ambient usage meters whenever usage data is present', async () => {
    await renderBilling({ planId: 'seedling', usage: usage() });
    expect(screen.getByTestId('usage-meters')).toBeInTheDocument();
    expect(screen.getByText('4 of 10 plants')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 members')).toBeInTheDocument();
    // Within limits → no over-limit banner.
    expect(screen.queryByText('Over your plan limit')).not.toBeInTheDocument();
  });

  it('renders no meters (and no banner) when the backend omits usage', async () => {
    await renderBilling({ planId: 'seedling' });
    expect(screen.queryByTestId('usage-meters')).not.toBeInTheDocument();
    expect(screen.queryByText('Over your plan limit')).not.toBeInTheDocument();
  });

  it('shows the over-limit banner after a downgrade leaves the household over its caps', async () => {
    await renderBilling({
      planId: 'seedling',
      stripeCustomerId: 'cus_1',
      usage: { plantCount: 25, maxPlants: 10, memberCount: 4, maxMembers: 1 },
    });
    expect(screen.getByText('Over your plan limit')).toBeInTheDocument();
    // Read/edit/delete keep working; adding is what's blocked.
    expect(screen.getByText(/view, edit, and remove/)).toBeInTheDocument();
    // Historical Stripe state does not reopen a billing-management surface.
    expect(screen.queryByRole('button', { name: 'Manage subscription' })).not.toBeInTheDocument();
    // Meters still render, flagged as over.
    expect(screen.getByText('25 of 10 plants')).toBeInTheDocument();
  });

  it('shows the banner without the manage link when there is no Stripe customer', async () => {
    await renderBilling({
      planId: 'seedling',
      usage: { plantCount: 25, maxPlants: 10, memberCount: 1, maxMembers: 1 },
    });
    expect(screen.getByText('Over your plan limit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage subscription' })).not.toBeInTheDocument();
  });

  it('shows only current plan status on the web, with no commercial controls or amounts', async () => {
    await renderBilling({ planId: 'seedling' });
    expect(screen.getByText(/paid plan changes are paused/i)).toBeInTheDocument();
    expect(screen.getByText(/current plan limits/i)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Billing interval' })).not.toBeInTheDocument();
    expect(screen.queryByText('Greenhouse')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /upgrade|subscribe|manage/i })
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    expect(screen.queryByText("Plan changes aren't available in the app.")).not.toBeInTheDocument();
  });

  describe('inside the native (Capacitor) shells', () => {
    beforeEach(() => {
      // Simulate the global the Capacitor bridge injects (lib/platform.ts
      // reads it instead of importing @capacitor/core).
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });

    afterEach(() => {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    });

    it('hides ALL purchase UI (store payment rules) and shows the read-only notice', async () => {
      await renderBilling({
        planId: 'garden',
        stripeCustomerId: 'cus_1',
        usage: usage(),
      });
      // No checkout cards (Greenhouse is the non-current plan here), no
      // cadence toggle, no Stripe portal button.
      expect(screen.queryByText('Greenhouse')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Upgrade to/ })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('radiogroup', { name: 'Billing interval' })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Manage subscription' })).not.toBeInTheDocument();
      // Read-only state: current plan + usage still visible, plus the notice.
      expect(screen.getByText("Plan changes aren't available in the app.")).toBeInTheDocument();
      expect(screen.getByTestId('usage-meters')).toBeInTheDocument();
    });

    it('hides the over-limit banner portal link on native too', async () => {
      await renderBilling({
        planId: 'seedling',
        stripeCustomerId: 'cus_1',
        usage: { plantCount: 25, maxPlants: 10, memberCount: 1, maxMembers: 1 },
      });
      expect(screen.getByText('Over your plan limit')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Manage subscription' })).not.toBeInTheDocument();
    });
  });

  it('does not expose retained monthly, annual, or lifetime pricing', async () => {
    await renderBilling({ planId: 'seedling' });
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    expect(
      screen.queryByText(/monthly|annual|lifetime|billed yearly|pay once/i)
    ).not.toBeInTheDocument();
  });
});
