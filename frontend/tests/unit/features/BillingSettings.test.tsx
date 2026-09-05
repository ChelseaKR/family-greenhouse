import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BillingSettings } from '@/features/settings/BillingSettings';
import {
  evaluatePlanLimits,
  resolvePlanUsage,
  type IdentifyTopUpOffer,
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
