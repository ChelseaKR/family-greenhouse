import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BillingSettings } from '@/features/settings/BillingSettings';
import {
  evaluatePlanLimits,
  readOutcome,
  resolveCurrentPlan,
  resolvePlanUsage,
  resolveTrialOffer,
  type IdentifyTopUpOffer,
  type Plan,
  type PlanCatalog,
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
    // Exactly the surface `billingService` exports today. `startCheckout` and
    // `openPortal` were removed with the purchase UI; mocking names the module
    // no longer has proved nothing and quietly implied a purchase path still
    // existed here.
    billingService: {
      listPlans: vi.fn(),
      getCurrentSubscription: vi.fn(),
      createCheckout: vi.fn(),
      createPortalSession: vi.fn(),
      createTopUpCheckout: vi.fn(),
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

async function renderBilling(
  sub: SubscriptionState,
  {
    paid = false,
    route = '/settings/billing',
    identifyTopUp,
  }: { paid?: boolean; route?: string; identifyTopUp?: IdentifyTopUpOffer } = {}
) {
  const { billingService } = await import('@/services/billingService');
  vi.mocked(billingService.listPlans).mockResolvedValue({
    paymentsAvailable: paid,
    commercialHold: { active: !paid, effectiveDate: '2026-07-14' },
    plans: paid ? PRICED_PLANS : PLANS,
    ...(identifyTopUp ? { identifyTopUp } : {}),
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
      <MemoryRouter initialEntries={[route]}>
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

  it('re-reads entitlement after returning from checkout, since only the webhook knows', async () => {
    // The app-wide query defaults (5-minute staleTime, refetchOnWindowFocus
    // off) are right for data this client mutates. Entitlement is not: Stripe
    // tells the server via webhook and this client is never informed, so
    // without an override a household that just paid keeps seeing its old
    // plan — and reasonably tries paying again.
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.getCurrentSubscription)
      .mockResolvedValueOnce({ planId: 'seedling' })
      .mockResolvedValue({ planId: 'garden', stripeCustomerId: 'cus_1', status: 'active' });

    await renderBilling(
      { planId: 'seedling' },
      { paid: true, route: '/settings/billing?status=success' }
    );

    // The first read still shows the pre-purchase row; polling picks up the
    // webhook's write shortly after.
    await waitFor(() => expect(billingService.getCurrentSubscription).toHaveBeenCalledTimes(2), {
      timeout: 6000,
    });
  });

  it('tells a trialing household when its first charge lands', async () => {
    // A trial that does not say when it ends is a surprise charge with extra
    // steps: status stays trialing, nothing on the page changes, and the
    // household has no way to know it has not been billed yet or when it will
    // be.
    await renderBilling(
      {
        planId: 'garden',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'trialing',
        currentPeriodEnd: '2026-09-17T02:45:20.000Z',
      },
      { paid: true }
    );

    // The status marker on the plan line, and the date sentence below it.
    expect(screen.getByText(/plan \(free trial\)/)).toBeInTheDocument();
    expect(screen.getByText(/Your free trial ends on/)).toBeInTheDocument();
    expect(screen.getByText(/You will not be charged before then/)).toBeInTheDocument();
  });

  it('does not promise a trial end date to a household that already cancelled', async () => {
    // Two dates would contradict each other; the cancellation notice is the
    // more useful message.
    await renderBilling(
      {
        planId: 'garden',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'trialing',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-09-17T02:45:20.000Z',
      },
      { paid: true }
    );

    expect(screen.queryByText(/Your free trial ends on/)).not.toBeInTheDocument();
    expect(screen.getByText(/Cancelled/)).toBeInTheDocument();
  });

  it('treats an unknown status on a live subscription as live, not as no subscription', async () => {
    // checkout.session.completed records the subscription id without a status,
    // so there is a window where the row cannot describe a subscription the
    // household really holds. Offering a purchase button there earns a 409 at
    // best and a second concurrent subscription at worst.
    await renderBilling(
      { planId: 'garden', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
      { paid: true }
    );

    expect(screen.queryByRole('button', { name: 'Switch to Greenhouse' })).not.toBeInTheDocument();
    expect(screen.getByText(/Manage subscription.*to switch to Greenhouse/)).toBeInTheDocument();
  });

  it('tells a cancelled household when its plan actually ends', async () => {
    // Stripe keeps a cancelled subscription serving until the period ends, so
    // status stays trialing/active and nothing else on the page changes.
    // Without this notice the cancellation is completely invisible.
    await renderBilling(
      {
        planId: 'greenhouse',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'trialing',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-09-16T05:19:51.000Z',
      },
      { paid: true }
    );

    expect(screen.getByText(/Cancelled/)).toBeInTheDocument();
    expect(screen.getByText(/returns to Seedling/)).toBeInTheDocument();
  });

  it('shows no cancellation notice for a household that has not cancelled', async () => {
    await renderBilling(
      {
        planId: 'greenhouse',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'active',
      },
      { paid: true }
    );
    expect(screen.queryByText(/Cancelled/)).not.toBeInTheDocument();
  });

  it('never offers a tier the household already owns outright', async () => {
    // A lifetime purchase has no stripeSubscriptionId, so hasLiveSubscription
    // is false and the double-billing guard cannot see it. Without an
    // explicit check the UI would invite the household to buy Garden again.
    await renderBilling(
      { planId: 'garden', stripeCustomerId: 'cus_1', lifetimePlanId: 'garden' },
      { paid: true }
    );

    expect(screen.queryByRole('button', { name: /Garden/ })).not.toBeInTheDocument();
    expect(screen.getByText('You own this plan permanently.')).toBeInTheDocument();
  });

  it('still offers a strictly higher tier to a lifetime owner', async () => {
    // Lifetime is a floor, not a ceiling — Greenhouse is genuinely more than
    // what they bought, and the marker survives the upgrade.
    await renderBilling(
      { planId: 'garden', stripeCustomerId: 'cus_1', lifetimePlanId: 'garden' },
      { paid: true }
    );
    expect(screen.getByRole('button', { name: 'Switch to Greenhouse' })).toBeInTheDocument();
  });

  it("does not offer a purchase path for the household's current plan", async () => {
    await renderBilling({ planId: 'garden' }, { paid: true });
    expect(screen.queryByRole('button', { name: 'Switch to Garden' })).not.toBeInTheDocument();
    expect(screen.getByText('This is your current plan.')).toBeInTheDocument();
  });
});

/**
 * The 14-day trial is once per HOUSEHOLD (`trialConsumedAt`, never cleared by
 * cancellation), but every trial sentence in the product was unconditional —
 * including this one, which sits directly above the purchase buttons (#602).
 *
 * A household that cancelled, or whose card failed until Stripe's dunning ran
 * out, is dropped to `seedling` with a dead status. `hasLiveSubscription` is
 * false, so this card renders the purchase grid again — and told them they had
 * 14 free days when the next click charges them at once.
 *
 * `trialAvailable` is the boolean that makes the sentence answerable. Three
 * states, and `unknown` is not folded into either: a missing field is an older
 * backend or a cached response, not evidence that the trial is gone.
 */
describe('BillingSettings — the free trial is once per household (#602)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin.mockReturnValue(true);
  });

  it('warns a returning household that its trial is spent and it will be charged', async () => {
    await renderBilling(
      { planId: 'seedling', stripeCustomerId: 'cus_1', status: 'canceled', trialAvailable: false },
      { paid: true }
    );

    // The purchase path really is open — this is the household that gets the
    // grid back, which is what made the old sentence dangerous rather than
    // merely imprecise.
    expect(screen.getByRole('button', { name: 'Switch to Garden' })).toBeInTheDocument();
    expect(
      screen.getByText(/already used its 14-day free trial/, { selector: 'p' })
    ).toBeInTheDocument();
    expect(screen.getByText(/charged straight away/, { selector: 'p' })).toBeInTheDocument();
  });

  it('tells a household that still has its trial that a new subscription starts with it', async () => {
    await renderBilling({ planId: 'seedling', trialAvailable: true }, { paid: true });

    const description = screen.getByText(/has not used its 14-day free trial yet/, {
      selector: 'p',
    });
    expect(description).toBeInTheDocument();
    expect(description).toHaveTextContent(/nothing is charged until it ends/);
  });

  it('states the rule, true either way, when the backend did not send the field', async () => {
    // Rolling deploy or a cached PWA response. Reading the absence as "used"
    // would frighten a first-time buyer; reading it as "available" would
    // repeat the original lie. So it says what is always true instead.
    await renderBilling({ planId: 'seedling' }, { paid: true });

    const description = screen.getByText(
      /first paid subscription starts with a 14-day free trial/,
      {
        selector: 'p',
      }
    );
    expect(description).toBeInTheDocument();
    expect(description).toHaveTextContent(/once per household/);
    // And it does not claim to know which case this household is in.
    expect(description).not.toHaveTextContent(/This household/);
  });
});

describe('resolveTrialOffer (three states, never two)', () => {
  it('keeps an absent field apart from a real false', () => {
    expect(resolveTrialOffer({ planId: 'seedling', trialAvailable: true })).toBe('available');
    expect(resolveTrialOffer({ planId: 'seedling', trialAvailable: false })).toBe('used');
    for (const subscription of [undefined, null, { planId: 'seedling' as const }]) {
      expect(resolveTrialOffer(subscription)).toBe('unknown');
    }
  });
});

describe('BillingSettings — identification top-up pack (ADR 0019)', () => {
  const OFFER: IdentifyTopUpOffer = {
    available: true,
    credits: 20,
    validityDays: 365,
    priceUsd: 1.99,
  };

  beforeEach(() => {
    isAdmin.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the pack with the household balance when the catalog offers it', async () => {
    await renderBilling(
      {
        planId: 'garden',
        identifyCredits: { remaining: 12, expiresAt: '2027-09-03T12:00:00.000Z' },
      },
      { paid: true, identifyTopUp: OFFER }
    );
    expect(screen.getByTestId('identify-top-up-card')).toBeInTheDocument();
    expect(screen.getByText('20 identifications for $1.99')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy 20 for $1.99' })).toBeInTheDocument();
    expect(screen.getByTestId('identify-credit-balance')).toHaveTextContent(
      /12 identification credits left/
    );
  });

  it('renders nothing for the pack when the catalog does not offer it and the household holds no credits', async () => {
    await renderBilling(
      { planId: 'garden', identifyCredits: { remaining: 0, expiresAt: null } },
      {
        paid: true,
        identifyTopUp: { available: false, credits: 20, validityDays: 365, priceUsd: 1.99 },
      }
    );
    expect(screen.queryByTestId('identify-top-up-card')).not.toBeInTheDocument();
  });

  it('renders nothing for the pack against an older backend that publishes no offer', async () => {
    await renderBilling({ planId: 'garden' }, { paid: true });
    expect(screen.queryByTestId('identify-top-up-card')).not.toBeInTheDocument();
  });

  it('keeps a held balance visible even when the pack is no longer for sale', async () => {
    await renderBilling(
      { planId: 'garden', identifyCredits: { remaining: 4, expiresAt: null } },
      {
        paid: true,
        identifyTopUp: { available: false, credits: 20, validityDays: 365, priceUsd: 1.99 },
      }
    );
    expect(screen.getByTestId('identify-top-up-card')).toBeInTheDocument();
    expect(screen.getByText('4 identification credits left')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Buy/ })).not.toBeInTheDocument();
  });

  it('reports an unreadable balance as unavailable, never as 0', async () => {
    await renderBilling(
      { planId: 'garden', identifyCredits: null },
      { paid: true, identifyTopUp: OFFER }
    );
    const balance = screen.getByTestId('identify-credit-balance');
    expect(balance).toHaveTextContent(/couldn't read your identification credit balance/i);
    expect(balance).not.toHaveTextContent(/No identification credits left/);
  });

  it('withholds the purchase while payments are paused even if a stale catalog says available', async () => {
    await renderBilling({ planId: 'garden' }, { paid: false, identifyTopUp: OFFER });
    expect(screen.queryByRole('button', { name: /Buy 20/ })).not.toBeInTheDocument();
  });

  it('shows members the admin-only reason instead of a button', async () => {
    isAdmin.mockReturnValue(false);
    await renderBilling({ planId: 'garden' }, { paid: true, identifyTopUp: OFFER });
    expect(screen.queryByRole('button', { name: /Buy 20/ })).not.toBeInTheDocument();
    expect(
      screen.getByText('Only a household admin can buy identification packs.')
    ).toBeInTheDocument();
  });

  it('acknowledges a return from a top-up checkout while the webhook catches up', async () => {
    await renderBilling(
      { planId: 'garden', identifyCredits: { remaining: 0, expiresAt: null } },
      {
        paid: true,
        identifyTopUp: OFFER,
        route: '/settings/billing?status=success&purchase=identify-top-up',
      }
    );
    expect(
      screen.getByText(/credits will show here as soon as the payment is confirmed/i)
    ).toBeInTheDocument();
  });
});

describe('usage meters against an unlimited cap (ADR 0014)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('states the count with no ceiling and draws no bar', async () => {
    await renderBilling({
      planId: 'garden',
      usageDetail: { plantCount: 12, maxPlants: 200, memberCount: 40, maxMembers: null },
    });

    expect(await screen.findByText('40 members · no limit')).toBeInTheDocument();
    expect(screen.getByText('12 of 200 plants')).toBeInTheDocument();
    // A bar needs a ceiling to fill; unlimited has none, so there is nothing
    // to draw — and 40/null must never render as a full or empty bar.
    expect(screen.queryByTestId('usage-meter-members-bar')).not.toBeInTheDocument();
    expect(screen.getByTestId('usage-meter-plants-bar')).toBeInTheDocument();
    expect(screen.getByTestId('usage-meter-members')).toHaveAttribute('data-state', 'within');
    expect(screen.queryByText('Over your plan limit')).not.toBeInTheDocument();
  });

  it('still says "usage unavailable" when the COUNT is unknown under an unlimited cap', async () => {
    await renderBilling({
      planId: 'garden',
      usageDetail: { plantCount: 4, maxPlants: 200, memberCount: null, maxMembers: null },
    });

    expect(await screen.findByText('Members — usage unavailable')).toBeInTheDocument();
    // The ROW says it could not read the count — never "0 members", the
    // repo's named defect. The BANNER does not appear, and that is not the
    // same failure: it asks "are you within your limits?", and against a cap
    // of null that is answerable without the counter. The plant count, which
    // does have a ceiling, was read fine.
    expect(screen.queryByText(/0 members/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-meter-members-bar')).not.toBeInTheDocument();
    expect(screen.queryByText("We couldn't check your plan usage")).not.toBeInTheDocument();
  });

  it('does raise the can\u2019t-check banner when a CAPPED dimension is unreadable', async () => {
    await renderBilling({
      planId: 'garden',
      usageDetail: { plantCount: null, maxPlants: 200, memberCount: 5, maxMembers: null },
    });

    expect(await screen.findByText("We couldn't check your plan usage")).toBeInTheDocument();
    expect(screen.getByText('— of 200 plants — usage unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('usage-meter-plants')).toHaveAttribute('data-state', 'unknown');
  });

  it('keeps the over-limit banner for a grandfathered household above a capped dimension', async () => {
    await renderBilling({
      planId: 'garden',
      usageDetail: { plantCount: 300, maxPlants: 200, memberCount: 5, maxMembers: null },
    });

    expect(await screen.findByText('Over your plan limit')).toBeInTheDocument();
    expect(screen.getByText('300 of 200 plants')).toBeInTheDocument();
    expect(screen.getByTestId('usage-meter-plants')).toHaveAttribute('data-state', 'over');
    expect(screen.getByTestId('usage-meter-members')).toHaveAttribute('data-state', 'within');
  });
});

describe('resolveCurrentPlan / readOutcome (never a plan we did not read)', () => {
  it('calls a disabled query settled-unavailable, not loading', () => {
    // `enabled: false` (no active household yet) leaves react-query pending
    // FOREVER with fetchStatus 'idle'. Nothing more is coming, so it has
    // settled without data. Reading that as "still loading" is how a
    // never-attempted read fell through to the free tier.
    expect(readOutcome({ status: 'pending', fetchStatus: 'idle' })).toBe('unavailable');
    expect(readOutcome({ status: 'pending', fetchStatus: 'fetching' })).toBe('loading');
    expect(readOutcome({ status: 'error', fetchStatus: 'idle' })).toBe('unavailable');
    expect(readOutcome({ status: 'success', fetchStatus: 'idle' })).toBe('ready');
  });

  it('never answers with a plan when the subscription read failed', () => {
    const read = resolveCurrentPlan({
      subscription: 'unavailable',
      subscriptionData: undefined,
      catalog: 'ready',
      plans: PLANS,
    });
    expect(read.status).toBe('unavailable');
    expect(read.unavailable).toBe(true);
    expect(read.planId).toBeNull();
    // The defect this replaces: `subQuery.data?.planId ?? 'seedling'`.
    expect(read.planId).not.toBe('seedling');
    expect(read.planName).toBeNull();
    expect(read.planName).not.toBe('Seedling');
  });

  it('never answers with a plan when the catalog read failed', () => {
    const read = resolveCurrentPlan({
      subscription: 'ready',
      subscriptionData: { planId: 'greenhouse' },
      catalog: 'unavailable',
      plans: undefined,
    });
    expect(read.status).toBe('unavailable');
    // The tier itself WAS read, so it is kept — but it is not enough on its
    // own to claim which plan the household is on.
    expect(read.planId).toBe('greenhouse');
    expect(read.planName).toBeNull();
  });

  it('does not fall back to the free tier when the catalog cannot name the tier', () => {
    // A catalog that settled fine but does not carry the household's tier —
    // a partial projection, or a tier newer than this client. The old code
    // answered `?.name ?? 'Seedling'` here.
    const read = resolveCurrentPlan({
      subscription: 'ready',
      subscriptionData: { planId: 'greenhouse' },
      catalog: 'ready',
      plans: PLANS.filter((p) => p.id !== 'greenhouse'),
    });
    expect(read.status).toBe('unavailable');
    expect(read.planName).not.toBe('Seedling');
    expect(read.planName).toBeNull();
  });

  it('is loading — not unavailable — while either read is still in flight', () => {
    for (const input of [
      { subscription: 'loading', catalog: 'ready' },
      { subscription: 'ready', catalog: 'loading' },
    ] as const) {
      const read = resolveCurrentPlan({
        ...input,
        subscriptionData: { planId: 'garden' },
        plans: PLANS,
      });
      expect(read.status).toBe('loading');
      // "We have not looked yet" and "we could not look" are different
      // answers, and only one of them is worth telling somebody about.
      expect(read.unavailable).toBe(false);
    }
  });

  it('answers with the real plan when both reads settled', () => {
    const read = resolveCurrentPlan({
      subscription: 'ready',
      subscriptionData: { planId: 'greenhouse' },
      catalog: 'ready',
      plans: PLANS,
    });
    expect(read).toEqual({
      status: 'ready',
      planId: 'greenhouse',
      planName: 'Greenhouse',
      unavailable: false,
    });
  });
});

/**
 * The highest-stakes instance of the repo's dominant defect class: a household
 * paying $9.99/mo, on the one screen it would open to check exactly that,
 * being told as a flat statement of fact that it is on the free plan.
 */
describe('BillingSettings — a failed read is never rendered as the free plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderWithReads({
    plans,
    subscription,
    paid = true,
  }: {
    plans: () => Promise<PlanCatalog>;
    subscription: () => Promise<SubscriptionState>;
    paid?: boolean;
  }) {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listPlans).mockImplementation(plans);
    vi.mocked(billingService.getCurrentSubscription).mockImplementation(subscription);
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
        <MemoryRouter initialEntries={['/settings/billing']}>
          <BillingSettings />
        </MemoryRouter>
      </QueryClientProvider>
    );
    // Present in every settled state, so waiting on it does not presuppose
    // which one we are asserting.
    await screen.findByText('Plan status');
    void paid;
  }

  const catalog = (over: Partial<PlanCatalog> = {}): PlanCatalog => ({
    paymentsAvailable: true,
    commercialHold: { active: false, effectiveDate: '2026-07-14' },
    plans: PRICED_PLANS,
    ...over,
  });

  it('says it could not check, instead of "Seedling", when the subscription read fails', async () => {
    await renderWithReads({
      plans: () => Promise.resolve(catalog()),
      subscription: () => Promise.reject(new Error('502 Bad Gateway')),
    });

    // The claim that must never be made from a failed read. Asserted against
    // full textContent on purpose: the old markup put the plan name in its own
    // <span>, so a node-local text matcher would sail straight past the very
    // sentence under test.
    expect(document.body.textContent).not.toMatch(/on the Seedling plan/i);
    expect(document.body.textContent).not.toMatch(/Seedling/);
    expect(screen.queryByTestId('current-plan')).not.toBeInTheDocument();
    expect(screen.getByText(/We couldn't check which plan you're on/)).toBeInTheDocument();
    expect(screen.getByTestId('plan-unavailable')).toBeInTheDocument();
  });

  it('does not offer a purchase while the household’s current plan is unknown', async () => {
    // Fail closed, exactly as the live-subscription guard does: we do not
    // know what this household already has, so every CTA would be a guess —
    // including inviting it to buy a plan it is already paying for.
    await renderWithReads({
      plans: () => Promise.resolve(catalog()),
      subscription: () => Promise.reject(new Error('502 Bad Gateway')),
    });

    expect(screen.queryByRole('button', { name: 'Switch to Garden' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch to Greenhouse' })).not.toBeInTheDocument();
    // And it says WHY, rather than leaving a blank card that reads as "no
    // plans are for sale".
    expect(screen.getByTestId('change-plan-unavailable')).toBeInTheDocument();
  });

  it('does not name the free tier when the catalog cannot name the household’s tier', async () => {
    await renderWithReads({
      plans: () =>
        Promise.resolve(catalog({ plans: PRICED_PLANS.filter((p) => p.id !== 'greenhouse') })),
      subscription: () =>
        Promise.resolve({
          planId: 'greenhouse',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
          status: 'active',
        } as SubscriptionState),
    });

    expect(document.body.textContent).not.toMatch(/on the Seedling plan/i);
    expect(screen.getByTestId('plan-unavailable')).toBeInTheDocument();
  });

  it('still states the real plan for a household whose reads both settled', async () => {
    // The negative control on the fix itself: "we could not check" must not
    // become the new blanket answer.
    await renderWithReads({
      plans: () => Promise.resolve(catalog()),
      subscription: () =>
        Promise.resolve({
          planId: 'greenhouse',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
          status: 'active',
        } as SubscriptionState),
    });

    expect(screen.getByTestId('current-plan')).toHaveTextContent(
      'Your household is on the Greenhouse plan.'
    );
    expect(screen.queryByTestId('plan-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('change-plan-unavailable')).not.toBeInTheDocument();
  });

  it('names a cancelled household’s tier from what it read, never from a default', async () => {
    // The catalog settled without this tier, so there is no display name. The
    // notice still names the tier the SUBSCRIPTION returned — read, not
    // invented — rather than rendering an empty gap or "Seedling".
    await renderWithReads({
      plans: () =>
        Promise.resolve(catalog({ plans: PRICED_PLANS.filter((p) => p.id !== 'greenhouse') })),
      subscription: () =>
        Promise.resolve({
          planId: 'greenhouse',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
          status: 'active',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: '2026-09-16T05:19:51.000Z',
        } as SubscriptionState),
    });

    expect(screen.getByText(/your greenhouse plan ends on/i)).toBeInTheDocument();
    expect(screen.queryByText(/your Seedling plan ends/i)).not.toBeInTheDocument();
  });
});
