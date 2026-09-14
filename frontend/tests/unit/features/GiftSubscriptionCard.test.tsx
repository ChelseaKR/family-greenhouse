import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  GiftSubscriptionCard,
  type GiftSubscriptionCardProps,
} from '@/features/billing/GiftSubscriptionCard';
import type { GiftPurchase, Plan } from '@/services/billingService';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual,
    billingService: {
      ...actual.billingService,
      createGiftCheckout: vi.fn(),
      redeemGiftCode: vi.fn(),
      listGiftPurchases: vi.fn(),
    },
  };
});

const isAdmin = vi.fn(() => true);
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => isAdmin(),
  useActiveHouseholdRole: () => (isAdmin() ? 'admin' : 'member'),
}));
vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

const PLANS: Plan[] = [
  {
    id: 'seedling',
    name: 'Seedling',
    description: '',
    maxPlants: 20,
    maxMembers: 3,
    monthlyPrice: 0,
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
];

const OFFER = {
  minMonths: 1,
  maxMonths: 12,
  redeemWindowDays: 365,
  plans: [
    { planId: 'garden' as const, available: true },
    { planId: 'greenhouse' as const, available: true },
  ],
};

const PURCHASE: GiftPurchase = {
  stripeSessionId: 'cs_1',
  code: 'FG-0123-4567-89AB-CDEF',
  planId: 'garden',
  months: 3,
  purchasedAt: '2026-09-13T12:00:00.000Z',
  redeemBy: '2027-09-13T12:00:00.000Z',
  status: 'unredeemed',
  redeemedAt: null,
  giftEndsAt: null,
};

function renderCard(props: Partial<GiftSubscriptionCardProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GiftSubscriptionCard
        offer={OFFER}
        plans={PLANS}
        paymentsAvailable
        gift={null}
        returnedFromPurchase={false}
        {...props}
      />
    </QueryClientProvider>
  );
}

function apiError(status: number, data: unknown = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}

describe('GiftSubscriptionCard', () => {
  const originalLocation = window.location;
  const assign = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    isAdmin.mockReturnValue(true);
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listGiftPurchases).mockResolvedValue([]);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('prices the gift at the monthly rate times the months, in exact cents, and hands the buyer to Stripe with a per-click attempt id', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.createGiftCheckout).mockResolvedValue({
      url: 'https://checkout.stripe.test/gift',
    });
    renderCard();
    // Defaults: Garden, 3 months → 3 × $4.99 = $14.97 (never $14.970000000000002).
    expect(screen.getByTestId('gift-total')).toHaveTextContent('3 × $4.99 a month = $14.97');
    await userEvent.selectOptions(screen.getByLabelText('Months'), '12');
    expect(screen.getByTestId('gift-total')).toHaveTextContent('12 × $4.99 a month = $59.88');
    await userEvent.selectOptions(screen.getByLabelText('Plan'), 'greenhouse');
    expect(screen.getByTestId('gift-total')).toHaveTextContent('12 × $9.99 a month = $119.88');

    await userEvent.click(screen.getByRole('button', { name: 'Buy gift for $119.88' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/gift'));
    const call = vi.mocked(billingService.createGiftCheckout).mock.calls[0][0];
    expect(call).toMatchObject({ planId: 'greenhouse', months: 12 });
    expect(call.checkoutAttemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('offers only the tiers the server says can be given, and nothing when none can', () => {
    renderCard({
      offer: {
        ...OFFER,
        plans: [
          { planId: 'garden', available: true },
          { planId: 'greenhouse', available: false },
        ],
      },
    });
    const plan = screen.getByLabelText('Plan');
    expect(
      within(plan)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Garden']);
    cleanup();
    renderCard({ paymentsAvailable: false });
    expect(screen.getByText("Gifts aren't available right now.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Buy gift/ })).not.toBeInTheDocument();
    // Redeeming does not depend on payments being on.
    expect(screen.getByLabelText('Gift code')).toBeInTheDocument();
  });

  it('shows a running gift with its end date, and that nothing is charged or renewed', () => {
    renderCard({
      gift: { planId: 'greenhouse', endsAt: '2026-12-13T14:00:00.000Z', state: 'active' },
    });
    const notice = screen.getByTestId('gift-active-notice');
    expect(notice).toHaveTextContent(/Your household has Greenhouse as a gift until/);
    expect(notice).toHaveTextContent(/Nothing is charged to your household and nothing renews/);
    cleanup();
    renderCard({ gift: { planId: 'garden', endsAt: '2026-01-01T00:00:00.000Z', state: 'ended' } });
    expect(screen.queryByTestId('gift-active-notice')).not.toBeInTheDocument();
  });

  it('lists the gifts this account bought with their codes and honest statuses', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listGiftPurchases).mockResolvedValue([
      PURCHASE,
      {
        ...PURCHASE,
        stripeSessionId: 'cs_2',
        status: 'redeemed',
        redeemedAt: '2026-10-01T00:00:00.000Z',
      },
      { ...PURCHASE, stripeSessionId: 'cs_3', status: 'unknown' },
    ]);
    renderCard();
    await screen.findByTestId('gift-purchases');
    const codes = screen.getAllByTestId('gift-code').map((c) => c.textContent);
    expect(codes).toEqual([
      'FG-0123-4567-89AB-CDEF',
      'FG-0123-4567-89AB-CDEF',
      'FG-0123-4567-89AB-CDEF',
    ]);
    const statuses = screen.getAllByTestId('gift-purchase-status').map((s) => s.textContent);
    expect(statuses[0]).toMatch(/Not redeemed yet/);
    expect(statuses[1]).toMatch(/Redeemed on/);
    expect(statuses[2]).toBe("We couldn't check whether this has been redeemed.");
  });

  it('says the list could not be read rather than showing an empty one', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listGiftPurchases).mockRejectedValue(apiError(502));
    renderCard();
    await screen.findByTestId('gift-purchases-unavailable');
    expect(screen.queryByTestId('gift-purchases-empty')).not.toBeInTheDocument();
  });

  it('redeems a code as an admin, names the plan and end date, and re-reads the subscription', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.redeemGiftCode).mockResolvedValue({
      planId: 'garden',
      endsAt: '2027-01-01T09:30:00.000Z',
    });
    renderCard();
    await userEvent.type(screen.getByLabelText('Gift code'), 'fg-0123 4567-89ab-cdef');
    await userEvent.click(screen.getByRole('button', { name: 'Redeem' }));
    await screen.findByTestId('gift-redeemed');
    expect(screen.getByTestId('gift-redeemed')).toHaveTextContent(
      /your household has Garden until/
    );
    expect(billingService.redeemGiftCode).toHaveBeenCalledWith({ code: 'fg-0123 4567-89ab-cdef' });
    // The field is cleared: the code is spent and must not be resubmitted.
    expect(screen.getByLabelText('Gift code')).toHaveValue('');
  });

  it('maps each refusal to its sentence, and says the code stays valid where it does', async () => {
    const { billingService } = await import('@/services/billingService');
    renderCard();
    const cases: Array<[number, Record<string, unknown>, RegExp]> = [
      [400, { code: 'GIFT_CODE_INVALID' }, /That code isn't valid/],
      [
        400,
        { code: 'GIFT_CODE_EXPIRED', redeemBy: '2027-09-13T12:00:00.000Z' },
        /can no longer be redeemed/,
      ],
      [409, { code: 'GIFT_CODE_REDEEMED' }, /already been redeemed/],
      [409, { code: 'GIFT_HOUSEHOLD_SUBSCRIBED' }, /The code stays valid/],
      [
        409,
        { code: 'GIFT_ALREADY_ACTIVE', endsAt: '2026-12-01T00:00:00.000Z' },
        /already has a gift running until/,
      ],
      [409, { code: 'GIFT_ADDS_NOTHING' }, /stays valid for another household/],
      [409, { code: 'GIFT_REDEEM_CONFLICT' }, /Nothing was used/],
    ];
    for (const [status, details, sentence] of cases) {
      vi.mocked(billingService.redeemGiftCode).mockRejectedValueOnce(apiError(status, { details }));
      await userEvent.clear(screen.getByLabelText('Gift code'));
      await userEvent.type(screen.getByLabelText('Gift code'), 'FG-0123-4567-89AB-CDEF');
      await userEvent.click(screen.getByRole('button', { name: 'Redeem' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(sentence));
    }
    vi.mocked(billingService.redeemGiftCode).mockRejectedValueOnce(apiError(429));
    await userEvent.click(screen.getByRole('button', { name: 'Redeem' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Too many attempts/));
  });

  it('tells a member that redeeming is an admin action instead of hiding it', () => {
    isAdmin.mockReturnValue(false);
    renderCard();
    expect(screen.getByText('Only a household admin can redeem a gift.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Gift code')).not.toBeInTheDocument();
    // Buying is open to any member: it is their own card.
    expect(screen.getByRole('button', { name: /Buy gift/ })).toBeInTheDocument();
  });

  it('names the purchase refusals without claiming a charge was made', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.createGiftCheckout).mockRejectedValueOnce(
      apiError(400, { details: { code: 'GIFT_NOT_CONFIGURED' } })
    );
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: /Buy gift/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Gifts aren't available right now. No charge was made./
      )
    );
    vi.mocked(billingService.createGiftCheckout).mockRejectedValueOnce(apiError(503));
    await userEvent.click(screen.getByRole('button', { name: /Buy gift/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Payments are currently paused/)
    );
    expect(assign).not.toHaveBeenCalled();
  });
});
