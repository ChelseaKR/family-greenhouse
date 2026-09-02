import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
      createCheckout: vi.fn(),
      createPortalSession: vi.fn(),
    },
  };
});

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

const isAdmin = vi.fn(() => true);
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => isAdmin(),
  useActiveHouseholdRole: () => (isAdmin() ? 'admin' : 'member'),
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

/** Catalog as the API projects it once both commercial gates are open: the
 *  same tiers, now carrying the price fields the server withholds while
 *  payment activity is disabled. */
const PRICED_PLANS: Plan[] = [
  { ...PLANS[0], monthlyPrice: 0, annualPrice: null, lifetimePrice: null },
  { ...PLANS[1], monthlyPrice: 4.99, annualPrice: 39.99, lifetimePrice: 149 },
  { ...PLANS[2], monthlyPrice: 9.99, annualPrice: 79.99, lifetimePrice: null },
];

async function renderBilling(sub: SubscriptionState, { paid = false } = {}) {
  const { billingService } = await import('@/services/billingService');
  vi.mocked(billingService.listPlans).mockResolvedValue({
    paymentsAvailable: paid,
    commercialHold: { active: !paid, effectiveDate: '2026-07-14' },
    plans: paid ? PRICED_PLANS : PLANS,
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
      expect(screen.queryByRole('group', { name: 'Billing interval' })).not.toBeInTheDocument();
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

describe('purchase controls once payment activity is available', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin.mockReturnValue(true);
  });

  it('follows the API, not the build-time flag, when deciding to show prices', async () => {
    // A frontend deployed ahead of its backend must not advertise amounts the
    // server is still refusing to honour.
    await renderBilling({ planId: 'seedling' }, { paid: false });
    expect(screen.getByText('Paid plan changes are paused')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s*\d/);

    cleanup();
    await renderBilling({ planId: 'seedling' }, { paid: true });
    expect(screen.queryByText('Paid plan changes are paused')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Garden' })).toBeInTheDocument();
  });

  it('starts checkout with a fresh idempotency key per click', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.createCheckout).mockResolvedValue({ url: 'https://pay.example/s1' });
    await renderBilling({ planId: 'seedling' }, { paid: true });

    await userEvent.click(screen.getByRole('button', { name: 'Switch to Garden' }));

    expect(billingService.createCheckout).toHaveBeenCalledWith({
      planId: 'garden',
      interval: 'month',
      checkoutAttemptId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      ),
    });
  });

  it('carries the selected interval into checkout', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.createCheckout).mockResolvedValue({ url: 'https://pay.example/s1' });
    await renderBilling({ planId: 'seedling' }, { paid: true });

    await userEvent.click(screen.getByRole('button', { name: /Yearly/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Switch to Garden' }));

    expect(billingService.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'garden', interval: 'year' })
    );
  });

  it('offers lifetime on Garden only, and never renders a paid tier as free', async () => {
    await renderBilling({ planId: 'seedling' }, { paid: true });
    await userEvent.click(screen.getByRole('button', { name: /Lifetime/ }));

    expect(screen.getByRole('button', { name: 'Buy Garden for life' })).toBeInTheDocument();
    // Greenhouse has no lifetime price: it must read as unavailable, never $0.
    expect(screen.queryByRole('button', { name: /Greenhouse/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Not available as a one-time purchase/)).toBeInTheDocument();
  });

  it('routes a household with a live subscription to the portal instead of a second purchase', async () => {
    // The API answers 409 here precisely to avoid billing twice; the UI should
    // not put the user in a position to earn that error.
    await renderBilling(
      {
        planId: 'garden',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'active',
      },
      { paid: true }
    );

    expect(screen.queryByRole('button', { name: 'Switch to Greenhouse' })).not.toBeInTheDocument();
    expect(screen.getByText(/Manage subscription.*to switch to Greenhouse/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeInTheDocument();
  });

  it('still allows a lifetime purchase alongside a live subscription', async () => {
    // Exempt by design: the lifetime webhook cancels the prior subscription.
    await renderBilling(
      {
        planId: 'garden',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'active',
      },
      { paid: true }
    );
    await userEvent.click(screen.getByRole('button', { name: /Lifetime/ }));
    // Same tier, so this is a conversion rather than a new purchase.
    expect(screen.getByRole('button', { name: 'Switch Garden to lifetime' })).toBeInTheDocument();
  });

  it('withholds purchase and portal controls from a non-admin member', async () => {
    isAdmin.mockReturnValue(false);
    await renderBilling({ planId: 'seedling', stripeCustomerId: 'cus_1' }, { paid: true });

    expect(screen.queryByRole('button', { name: 'Switch to Garden' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Only a household admin can/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeDisabled();
  });

  it('surfaces an actionable message instead of a raw failure', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.createCheckout).mockRejectedValue({ response: { status: 503 } });
    await renderBilling({ planId: 'seedling' }, { paid: true });

    await userEvent.click(screen.getByRole('button', { name: 'Switch to Garden' }));

    expect(
      await screen.findByText(/Payments are currently paused\. No charge was made\./)
    ).toBeInTheDocument();
  });

  it("does not offer a purchase path for the household's current plan", async () => {
    await renderBilling({ planId: 'garden' }, { paid: true });
    expect(screen.queryByRole('button', { name: 'Switch to Garden' })).not.toBeInTheDocument();
    expect(screen.getByText('This is your current plan.')).toBeInTheDocument();
  });
});
