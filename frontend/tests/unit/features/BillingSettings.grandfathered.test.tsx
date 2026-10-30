import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BillingSettings } from '@/features/settings/BillingSettings';
import type { Plan, SubscriptionState } from '@/services/billingService';
import { useAuthStore } from '@/store/authStore';

/**
 * Settings → Billing for a household created before the 2026-10-23 Seedling
 * cut (ADR 0040): its meters show 20 plants and 3 people while the plan list
 * says 8 and 2, so the page says why.
 */

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual,
    billingService: {
      listPlans: vi.fn(),
      getCurrentSubscription: vi.fn(),
      createCheckout: vi.fn(),
      createPortalSession: vi.fn(),
      createTopUpCheckout: vi.fn(),
    },
  };
});

vi.mock('@/hooks/useActiveHouseholdId', () => ({ useActiveHouseholdId: () => 'hh-1' }));
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => true,
  useActiveHouseholdRole: () => 'admin',
}));

const PLANS: Plan[] = [
  { id: 'seedling', name: 'Seedling', description: 'Free', maxPlants: 8, maxMembers: 2 },
  {
    id: 'garden',
    name: 'Garden',
    description: 'Families',
    maxPlants: 200,
    maxMembers: null,
    monthlyPrice: 4.99,
  },
] as Plan[];

async function renderBilling(sub: SubscriptionState) {
  const { billingService } = await import('@/services/billingService');
  vi.mocked(billingService.listPlans).mockResolvedValue({
    paymentsAvailable: true,
    commercialHold: { active: false, effectiveDate: '2026-09-01' },
    plans: PLANS,
  });
  vi.mocked(billingService.getCurrentSubscription).mockResolvedValue(sub);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings/billing']}>
        <BillingSettings />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('BillingSettings: grandfathered free caps (ADR 0040)', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'u-1', email: 'a@b.com', name: 'A', householdId: 'hh-1', householdRole: 'admin' },
    });
  });

  it('says why a September household is held to 20 plants and 3 people', async () => {
    await renderBilling({
      planId: 'seedling',
      usageDetail: { plantCount: 9, maxPlants: 20, memberCount: 2, maxMembers: 3 },
    });
    expect(await screen.findByTestId('free-caps-grandfathered')).toHaveTextContent(
      'This household was created before the free plan changed, so it keeps the free limits it signed up with: 20 plants and 3 people. Households created since then get 8 plants and 2 people.'
    );
    // Its meter shows its own cap, and it is not "over" anything.
    expect(await screen.findByText('9 of 20 plants')).toBeInTheDocument();
  });

  it('negative control: says nothing for a household on the current caps', async () => {
    await renderBilling({
      planId: 'seedling',
      usageDetail: { plantCount: 5, maxPlants: 8, memberCount: 1, maxMembers: 2 },
    });
    expect(await screen.findByText('5 of 8 plants')).toBeInTheDocument();
    expect(screen.queryByTestId('free-caps-grandfathered')).not.toBeInTheDocument();
  });
});
