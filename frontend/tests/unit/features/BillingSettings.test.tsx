import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BillingSettings } from '@/features/settings/BillingSettings';
import {
  evaluatePlanLimits,
  resolvePlanUsage,
  type Plan,
  type PlanUsage,
  type PlanUsageDetail,
  type SubscriptionState,
} from '@/services/billingService';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual, // keep evaluatePlanLimits (the real limit calc) and types
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

function usage(over: Partial<PlanUsageDetail> = {}): PlanUsageDetail {
  return { plantCount: 4, maxPlants: 10, memberCount: 1, maxMembers: 1, ...over };
}

function legacyUsage(over: Partial<PlanUsage> = {}): PlanUsage {
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

describe('evaluatePlanLimits (three states, never two)', () => {
  it('reports unknown — not "within" — when there is no usage data at all', () => {
    for (const value of [undefined, null] as const) {
      const limits = evaluatePlanLimits(value);
      expect(limits).toEqual({ plants: 'unknown', members: 'unknown', overall: 'unknown' });
      expect(limits.overall).not.toBe('within');
    }
  });

  it('is within at or under the caps (boundary: exactly at cap is NOT over)', () => {
    expect(evaluatePlanLimits(usage()).overall).toBe('within');
    expect(evaluatePlanLimits(usage({ plantCount: 10 })).overall).toBe('within');
    expect(evaluatePlanLimits(usage({ memberCount: 1 })).overall).toBe('within');
  });

  it('separates a genuine zero from an unknown count', () => {
    expect(evaluatePlanLimits(usage({ plantCount: 0 })).plants).toBe('within');
    expect(evaluatePlanLimits(usage({ plantCount: null })).plants).toBe('unknown');
  });

  it('is over when either plants or members exceed the cap', () => {
    expect(evaluatePlanLimits(usage({ plantCount: 11 })).overall).toBe('over');
    expect(evaluatePlanLimits(usage({ memberCount: 2 })).overall).toBe('over');
  });

  it('never lets an unknown count satisfy a limit', () => {
    // The defect this replaces: `isOverPlanLimit` answered `false` here, and
    // `false` was consumed as "this household is inside its plan".
    const cases: Array<Partial<PlanUsageDetail>> = [
      { plantCount: null, memberCount: null },
      { plantCount: null, memberCount: 1 },
      { plantCount: 4, memberCount: null },
      { plantCount: 0, memberCount: null },
    ];
    for (const override of cases) {
      const limits = evaluatePlanLimits(usage(override));
      expect(limits.overall).toBe('unknown');
      expect(limits.overall).not.toBe('within');
    }
  });

  it('lets a known overage outrank an unknown counter', () => {
    expect(evaluatePlanLimits(usage({ plantCount: 11, memberCount: null }))).toEqual({
      plants: 'over',
      members: 'unknown',
      overall: 'over',
    });
    expect(evaluatePlanLimits(usage({ plantCount: null, memberCount: 2 })).overall).toBe('over');
  });
});

describe('resolvePlanUsage (rolling-deploy compatibility)', () => {
  it('prefers nullable usageDetail over the legacy numeric shape', () => {
    const detail = usage({ plantCount: null, memberCount: 2 });
    expect(
      resolvePlanUsage({
        planId: 'seedling',
        usage: legacyUsage({ plantCount: 0, memberCount: 1 }),
        usageDetail: detail,
      })
    ).toBe(detail);
  });

  it('falls back to legacy usage and tolerates responses with neither shape', () => {
    const legacy = legacyUsage();
    expect(resolvePlanUsage({ planId: 'seedling', usage: legacy })).toBe(legacy);
    expect(resolvePlanUsage({ planId: 'seedling' })).toBeUndefined();
    expect(resolvePlanUsage(undefined)).toBeUndefined();
  });
});

describe('BillingSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows ambient usage meters whenever usage data is present', async () => {
    await renderBilling({ planId: 'seedling', usage: legacyUsage() });
    expect(screen.getByTestId('usage-meters')).toBeInTheDocument();
    expect(screen.getByText('4 of 10 plants')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 members')).toBeInTheDocument();
    // Within limits → neither the over-limit banner nor the can't-check one.
    expect(screen.queryByText('Over your plan limit')).not.toBeInTheDocument();
    expect(screen.queryByText("We couldn't check your plan usage")).not.toBeInTheDocument();
    expect(screen.getByTestId('usage-meter-plants')).toHaveAttribute('data-state', 'within');
  });

  it('renders a genuine zero as zero rather than unavailable', async () => {
    await renderBilling({ planId: 'seedling', usage: legacyUsage({ plantCount: 0 }) });

    expect(screen.getByText('0 of 10 plants')).toBeInTheDocument();
    expect(screen.getByTestId('usage-meter-plants-bar')).toBeInTheDocument();
    expect(screen.queryByText(/plants.*usage unavailable/i)).not.toBeInTheDocument();
    // A genuine zero IS a satisfied limit — and says so, unlike unknown.
    expect(screen.getByTestId('usage-meter-plants')).toHaveAttribute('data-state', 'within');
    expect(screen.queryByText("We couldn't check your plan usage")).not.toBeInTheDocument();
  });

  it('says it could not check when the backend omits usage entirely', async () => {
    await renderBilling({ planId: 'seedling' });
    expect(screen.queryByTestId('usage-meters')).not.toBeInTheDocument();
    expect(screen.queryByText('Over your plan limit')).not.toBeInTheDocument();
    // Silence here reads as "you're fine"; the card must not imply that.
    expect(screen.getByText("We couldn't check your plan usage")).toBeInTheDocument();
  });

  it('renders explicit accessible unavailable states instead of zero-value meters', async () => {
    await renderBilling({
      planId: 'seedling',
      usageDetail: { plantCount: null, maxPlants: 10, memberCount: null, maxMembers: 1 },
    });

    expect(screen.getByRole('list', { name: 'Usage' })).toBeInTheDocument();
    expect(screen.getByText('— of 10 plants — usage unavailable')).toBeInTheDocument();
    expect(screen.getByText('— of 1 members — usage unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('usage-meter-plants-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-meter-members-bar')).not.toBeInTheDocument();
    expect(screen.queryByText('0 of 10 plants')).not.toBeInTheDocument();
    expect(screen.queryByText('Over your plan limit')).not.toBeInTheDocument();
  });

  it('states that the limit could not be checked rather than staying silent', async () => {
    // The second-order half of #308: the meter already said "unavailable",
    // but the over-limit banner's absence still read as "you are under your
    // limit". Unknown now has its own message.
    await renderBilling({
      planId: 'seedling',
      usageDetail: { plantCount: null, maxPlants: 10, memberCount: 1, maxMembers: 1 },
    });

    expect(screen.getByText("We couldn't check your plan usage")).toBeInTheDocument();
    expect(
      screen.getByText(/we can't tell whether this household is within its plan limits/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Over your plan limit')).not.toBeInTheDocument();
    expect(screen.getByTestId('usage-meter-plants')).toHaveAttribute('data-state', 'unknown');
    expect(screen.getByTestId('usage-meter-members')).toHaveAttribute('data-state', 'within');
  });

  it('keeps the warning when one counter is unknown but the known counter is over its cap', async () => {
    await renderBilling({
      planId: 'seedling',
      // A stale/cached legacy value must not win over the detail supplied by
      // the current backend.
      usage: legacyUsage({ plantCount: 0, memberCount: 1 }),
      usageDetail: { plantCount: 25, maxPlants: 10, memberCount: null, maxMembers: 1 },
    });

    expect(screen.getByText('Over your plan limit')).toBeInTheDocument();
    expect(screen.getByText('25 of 10 plants')).toBeInTheDocument();
    expect(screen.getByText('— of 1 members — usage unavailable')).toBeInTheDocument();
    // A known overage is the actionable message; it outranks the unknown one
    // rather than showing both.
    expect(screen.queryByText("We couldn't check your plan usage")).not.toBeInTheDocument();
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
        usage: legacyUsage(),
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
