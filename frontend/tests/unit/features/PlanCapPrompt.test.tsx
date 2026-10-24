import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { PlanCapPrompt } from '@/features/billing/PlanCapPrompt';
import { capReached, grandfatheredFreeCaps } from '@/features/billing/planCaps';
import type { Plan, SubscriptionState } from '@/services/billingService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * ADR 0040: the free plan is 8 plants and 2 people, a household created before
 * the 2026-10-23 cut keeps 20 and 3, and a household at its cap is shown an
 * honest upgrade prompt before the form, with the catalog price.
 */

const API = 'http://localhost:4000';

const PLANS: Plan[] = [
  {
    id: 'seedling',
    name: 'Seedling',
    description: '',
    maxPlants: 8,
    maxMembers: 2,
  },
  {
    id: 'garden',
    name: 'Garden',
    description: '',
    maxPlants: 200,
    maxMembers: null,
    monthlyPrice: 4.99,
  },
  {
    id: 'greenhouse',
    name: 'Greenhouse',
    description: '',
    maxPlants: 5000,
    maxMembers: null,
    monthlyPrice: 9.99,
  },
] as Plan[];

function usage(
  plantCount: number | null,
  maxPlants: number | null,
  memberCount = 1,
  maxMembers = 2
) {
  return { plantCount, maxPlants, memberCount, maxMembers };
}

function signIn(role: 'admin' | 'member') {
  useAuthStore.setState({
    accessToken: 'access-1',
    user: {
      id: 'u-me',
      email: 'me@example.com',
      name: 'Sam',
      householdId: 'hh-1',
      householdRole: role,
    },
    activeHouseholdId: 'hh-1',
  });
  server.use(
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role, joinedAt: '' }])
    )
  );
}

function stubReads(subscription: Partial<SubscriptionState>) {
  let subscriptionReads = 0;
  server.use(
    http.get(`${API}/billing/plans`, () =>
      HttpResponse.json({
        paymentsAvailable: true,
        commercialHold: { active: false, effectiveDate: '2026-09-01' },
        plans: PLANS,
      })
    ),
    http.get(`${API}/billing/me`, () => {
      subscriptionReads += 1;
      return HttpResponse.json({ planId: 'seedling', ...subscription });
    }),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'u-admin',
        members: [
          { userId: 'u-admin', name: 'Maria', role: 'admin', joinedAt: '' },
          { userId: 'u-me', name: 'Sam', role: 'member', joinedAt: '' },
        ],
      })
    )
  );
  return { reads: () => subscriptionReads };
}

function renderPrompt(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    ),
    queryClient,
  };
}

describe('capReached (reads the ENFORCED caps, never the catalog)', () => {
  it('is reached at the cap and above it', () => {
    expect(capReached({ planId: 'seedling', usageDetail: usage(8, 8) }, 'plants')).toEqual({
      count: 8,
      max: 8,
    });
    expect(capReached({ planId: 'seedling', usageDetail: usage(11, 8) }, 'plants')).toEqual({
      count: 11,
      max: 8,
    });
  });

  it('is not reached below the cap, at an unlimited cap, or on an unread counter', () => {
    expect(capReached({ planId: 'seedling', usageDetail: usage(7, 8) }, 'plants')).toBeNull();
    expect(capReached({ planId: 'garden', usageDetail: usage(900, null) }, 'plants')).toBeNull();
    expect(capReached({ planId: 'seedling', usageDetail: usage(null, 8) }, 'plants')).toBeNull();
    expect(capReached(undefined, 'plants')).toBeNull();
  });

  it('negative control: a grandfathered 9-plant household is NOT at its cap', () => {
    // The catalog says 8, which this household is over; the server enforces
    // 20 for it. Reading the catalog here would wall it off eleven plants early.
    const sub = { planId: 'seedling' as const, usageDetail: usage(9, 20, 2, 3) };
    expect(capReached(sub, 'plants')).toBeNull();
    expect(capReached(sub, 'members')).toBeNull();
  });
});

describe('grandfatheredFreeCaps', () => {
  it('names the kept caps for a Seedling household held above the catalog', () => {
    expect(
      grandfatheredFreeCaps({ planId: 'seedling', usageDetail: usage(9, 20, 2, 3) }, PLANS)
    ).toEqual({ plants: 20, members: 3, newPlants: 8, newMembers: 2 });
  });

  it('says nothing for a household on the current caps, a paid household, or unread data', () => {
    expect(
      grandfatheredFreeCaps({ planId: 'seedling', usageDetail: usage(5, 8, 1, 2) }, PLANS)
    ).toBeNull();
    expect(
      grandfatheredFreeCaps(
        { planId: 'garden', status: 'active', usageDetail: usage(9, 200, 2, null as never) },
        PLANS
      )
    ).toBeNull();
    expect(grandfatheredFreeCaps({ planId: 'seedling' }, PLANS)).toBeNull();
    expect(
      grandfatheredFreeCaps({ planId: 'seedling', usageDetail: usage(9, 20, 2, 3) }, undefined)
    ).toBeNull();
  });
});

describe('PlanCapPrompt', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: null, user: null, activeHouseholdId: null });
  });

  it('shows an admin at the plant cap the count, that nothing is lost, the price, and the existing checkout', async () => {
    signIn('admin');
    stubReads({ usageDetail: usage(8, 8) });
    renderPrompt(<PlanCapPrompt cap="plants" />);

    expect(
      await screen.findByRole('heading', { name: 'Room for more plants' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your plan holds 8 active plants, and this household has 8. Every plant stays and can still be edited; only adding another waits for room. Archiving a plant you no longer care for frees a slot, or a plan with more room lifts the limit.'
      )
    ).toBeInTheDocument();
    expect(await screen.findByTestId('locked-included')).toHaveTextContent(
      'Included with Garden — $4.99 a month for the whole household'
    );
    expect(screen.getByRole('link', { name: 'Change plan' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
  });

  it('gives a member the one-tap ask instead of a purchase button', async () => {
    signIn('member');
    stubReads({ usageDetail: usage(1, 8, 2, 2) });
    renderPrompt(<PlanCapPrompt cap="members" />);

    expect(
      await screen.findByRole('heading', { name: 'Room for more people' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your plan holds 2 people, and this household has 2\. Everyone stays/)
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Ask Maria to upgrade' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change plan' })).not.toBeInTheDocument();
  });

  it('renders nothing below the cap, and nothing for a grandfathered household under its own cap', async () => {
    signIn('admin');
    const below = stubReads({ usageDetail: usage(7, 8) });
    const first = renderPrompt(<PlanCapPrompt cap="plants" />);
    await waitFor(() => expect(below.reads()).toBe(1));
    expect(screen.queryByTestId('plan-cap-prompt-plants')).not.toBeInTheDocument();
    first.unmount();

    const grandfathered = stubReads({ usageDetail: usage(9, 20, 2, 3) });
    renderPrompt(<PlanCapPrompt cap="plants" />);
    await waitFor(() => expect(grandfathered.reads()).toBe(1));
    expect(screen.queryByTestId('plan-cap-prompt-plants')).not.toBeInTheDocument();
  });

  describe('inside the native shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });
    afterEach(() => {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    });

    it('states the cap with no price and no purchase call (Guideline 3.1.1)', async () => {
      signIn('admin');
      stubReads({ usageDetail: usage(8, 8) });
      renderPrompt(<PlanCapPrompt cap="plants" />);

      expect(
        await screen.findByRole('heading', { name: 'Room for more plants' })
      ).toBeInTheDocument();
      expect(
        await screen.findByText("Plan changes aren't available in the app.")
      ).toBeInTheDocument();
      expect(screen.queryByTestId('locked-included')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Change plan' })).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/\$\s*\d/);
    });
  });
});
