import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  IdentifyTopUpCard,
  type IdentifyTopUpCardProps,
} from '@/features/billing/IdentifyTopUpCard';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual,
    billingService: {
      ...actual.billingService,
      createTopUpCheckout: vi.fn(),
    },
  };
});

const isAdmin = vi.fn(() => true);
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => isAdmin(),
  useActiveHouseholdRole: () => (isAdmin() ? 'admin' : 'member'),
}));

function renderCard(props: Partial<IdentifyTopUpCardProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IdentifyTopUpCard
        variant="billing"
        available
        credits={20}
        priceUsd={1.99}
        validityDays={365}
        {...props}
      />
    </QueryClientProvider>
  );
}

function apiError(status: number, data: unknown = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}

describe('IdentifyTopUpCard', () => {
  const originalLocation = window.location;
  const assign = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin.mockReturnValue(true);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('offers the pack with its price and terms, and hands an admin to Stripe with a per-click attempt id', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.createTopUpCheckout).mockResolvedValue({
      url: 'https://checkout.stripe.test/topup',
    });
    renderCard();

    expect(screen.getByText('20 identifications for $1.99')).toBeInTheDocument();
    expect(screen.getByText(/Credits are valid for 365 days from purchase/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Buy 20 for $1.99' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/topup'));
    expect(billingService.createTopUpCheckout).toHaveBeenCalledWith({
      checkoutAttemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('tells a member that buying is admin-only instead of showing nothing', async () => {
    isAdmin.mockReturnValue(false);
    const { billingService } = await import('@/services/billingService');
    renderCard();

    expect(screen.queryByRole('button', { name: /Buy 20/ })).not.toBeInTheDocument();
    expect(
      screen.getByText('Only a household admin can buy identification packs.')
    ).toBeInTheDocument();
    expect(billingService.createTopUpCheckout).not.toHaveBeenCalled();
  });

  it('leads with "used up" on the exhausted surface', () => {
    renderCard({ variant: 'exhausted', balance: { remaining: 0, expiresAt: null } });
    expect(screen.getByText("This month's identifications are used up")).toBeInTheDocument();
    expect(screen.getByText('No identification credits left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy 20 for $1.99' })).toBeInTheDocument();
  });

  it('shows a real balance with its expiry', () => {
    renderCard({ balance: { remaining: 17, expiresAt: '2027-09-03T12:00:00.000Z' } });
    expect(screen.getByTestId('identify-credit-balance')).toHaveTextContent(
      /17 identification credits left, valid until/
    );
  });

  it('says the balance is unavailable when it could not be read — never 0', () => {
    renderCard({ balance: null });
    const balance = screen.getByTestId('identify-credit-balance');
    expect(balance).toHaveTextContent(/couldn't read your identification credit balance/i);
    expect(balance).not.toHaveTextContent(/\b0\b/);
    expect(balance).not.toHaveTextContent(/No identification credits left/);
  });

  it('shows no balance line at all when this surface has none to show', () => {
    renderCard({ balance: undefined });
    expect(screen.queryByTestId('identify-credit-balance')).not.toBeInTheDocument();
  });

  it('offers no purchase when the pack is not for sale, but keeps the balance visible', () => {
    renderCard({ available: false, balance: { remaining: 3, expiresAt: null } });
    expect(screen.queryByRole('button', { name: /Buy/ })).not.toBeInTheDocument();
    expect(
      screen.getByText("Identification packs aren't available right now.")
    ).toBeInTheDocument();
    expect(screen.getByText('3 identification credits left')).toBeInTheDocument();
  });

  it('offers no purchase button when the price is withheld — a button with no price is a promise the API will not keep', () => {
    renderCard({ priceUsd: null });
    expect(screen.queryByRole('button', { name: /Buy/ })).not.toBeInTheDocument();
  });

  it.each([
    [
      400,
      { details: { code: 'TOP_UP_NOT_CONFIGURED' } },
      /aren't available right now\. No charge was made/,
    ],
    [503, {}, /Payments are currently paused/],
    [403, {}, /Only a household admin/],
    [502, {}, /could not reach our payment provider/],
  ])('maps a %s from the API onto an actionable message', async (status, data, expected) => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.createTopUpCheckout).mockRejectedValue(apiError(status, data));
    renderCard();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Buy 20 for $1.99' }));

    expect(await screen.findByText('Purchase could not be started')).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
