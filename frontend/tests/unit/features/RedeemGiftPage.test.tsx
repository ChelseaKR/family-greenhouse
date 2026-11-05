import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { RedeemGiftPage } from '@/features/gift/RedeemGiftPage';
import { PendingGiftCodeNotice } from '@/features/gift/PendingGiftCodeNotice';
import { giftRedeemLink, normalizeGiftCodeInput } from '@/features/gift/giftLink';
import {
  clearPendingGiftCode,
  getPendingGiftCode,
  setPendingGiftCode,
} from '@/features/gift/pendingGiftCode';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return {
    ...actual,
    billingService: {
      ...actual.billingService,
      listPlans: vi.fn().mockResolvedValue({ paymentsAvailable: true, plans: [] }),
      redeemGiftCode: vi.fn(),
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

import { billingService } from '@/services/billingService';

const CODE = 'FG-0123-4567-89AB-CDEF';

function signIn(householdId: string | null) {
  useAuthStore.setState({
    user: {
      id: 'user-2',
      email: 'friend@example.com',
      name: 'Friend',
      householdId,
      householdRole: householdId ? 'admin' : null,
    },
    isAuthenticated: true,
  });
}

function renderAt(hash = '', node = <RedeemGiftPage />, path = '/redeem') {
  window.history.replaceState(null, '', `${path}${hash}`);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('giftLink and pendingGiftCode', () => {
  afterEach(() => clearPendingGiftCode());

  it('normalizes what a person or a link carries, and rejects anything else', () => {
    expect(normalizeGiftCodeInput('fg-0123 4567-89ab-cdef')).toBe(CODE);
    expect(normalizeGiftCodeInput('FG0123456789ABCDEF')).toBe(CODE);
    expect(normalizeGiftCodeInput('%23FG-0123-4567-89AB-CDEF')).toBe(CODE);
    expect(normalizeGiftCodeInput('FG-0123')).toBeNull();
    expect(normalizeGiftCodeInput('<script>')).toBeNull();
    expect(normalizeGiftCodeInput(null)).toBeNull();
  });

  it('puts the code in the fragment, never the query string', () => {
    expect(giftRedeemLink(CODE, 'https://familygreenhouse.net')).toBe(
      'https://familygreenhouse.net/redeem#FG-0123-4567-89AB-CDEF'
    );
  });

  it('keeps a code for the visit, and says so when storage is blocked', () => {
    expect(setPendingGiftCode(CODE)).toBe(true);
    expect(getPendingGiftCode()).toBe(CODE);
    clearPendingGiftCode();
    expect(getPendingGiftCode()).toBeNull();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(setPendingGiftCode(CODE)).toBe(false);
    expect(setItem).toHaveBeenCalled();
    setItem.mockRestore();
    expect(setPendingGiftCode('not a code')).toBe(false);
  });
});

describe('RedeemGiftPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin.mockReturnValue(true);
    clearPendingGiftCode();
    useAuthStore.setState({ user: null, isAuthenticated: false });
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });
  afterEach(() => {
    cleanup();
    clearPendingGiftCode();
    window.history.replaceState(null, '', '/');
  });

  it('a signed-out visitor sees the code, is told it is kept, and gets register and sign-in links back here', async () => {
    renderAt(`#${CODE}`);
    expect(screen.getByTestId('redeem-code')).toHaveTextContent(CODE);
    expect(screen.getByTestId('redeem-kept')).toHaveTextContent(
      "We'll keep this code for you in this browser tab"
    );
    expect(screen.getByRole('link', { name: 'Create a free account' })).toHaveAttribute(
      'href',
      '/register?redirect=%2Fredeem'
    );
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?redirect=%2Fredeem'
    );
    // Kept for the trip through sign-up, and out of the address bar.
    expect(getPendingGiftCode()).toBe(CODE);
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(screen.getByTestId('redeem-trial-overlap')).toHaveTextContent(
      'overlap rather than add up'
    );
  });

  it('says to paste the code after signing in when storage is blocked', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderAt(`#${CODE}`);
    setItem.mockRestore();
    expect(screen.getByTestId('redeem-kept')).toHaveTextContent(
      'Copy it now, and paste it after you sign in.'
    );
    expect(screen.getByTestId('redeem-code')).toHaveTextContent(CODE);
  });

  it('a signed-in visitor with no household is sent to create one, code kept', () => {
    signIn(null);
    renderAt(`#${CODE}`);
    expect(screen.getByRole('link', { name: 'Create your household' })).toHaveAttribute(
      'href',
      '/onboarding'
    );
    expect(getPendingGiftCode()).toBe(CODE);
  });

  it('a member who is not an admin is told to ask the admin, with no form', () => {
    signIn('hh-1');
    isAdmin.mockReturnValue(false);
    renderAt(`#${CODE}`);
    expect(screen.getByText("Ask your household's admin")).toBeInTheDocument();
    expect(screen.queryByLabelText('Gift code')).not.toBeInTheDocument();
  });

  it('an admin back from onboarding finds the kept code filled in, and redeeming clears it', async () => {
    setPendingGiftCode(CODE);
    signIn('hh-1');
    vi.mocked(billingService.redeemGiftCode).mockResolvedValue({
      planId: 'garden',
      endsAt: '2027-03-20T10:00:00.000Z',
    });
    renderAt('');
    expect(screen.getByLabelText('Gift code')).toHaveValue(CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Redeem' }));
    await screen.findByTestId('gift-redeemed');
    expect(billingService.redeemGiftCode).toHaveBeenCalledWith({ code: CODE });
    expect(getPendingGiftCode()).toBeNull();
  });

  it('is not offered in the native app', () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    renderAt(`#${CODE}`);
    expect(screen.queryByTestId('redeem-page')).not.toBeInTheDocument();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });
});

describe('PendingGiftCodeNotice', () => {
  afterEach(() => {
    cleanup();
    clearPendingGiftCode();
  });

  it('shows "You have a gift code" with a link to /redeem only while a code is kept', () => {
    renderAt('', <PendingGiftCodeNotice />, '/dashboard');
    expect(screen.queryByTestId('pending-gift-code-notice')).not.toBeInTheDocument();
    cleanup();
    setPendingGiftCode(CODE);
    renderAt('', <PendingGiftCodeNotice />, '/dashboard');
    expect(screen.getByText('You have a gift code')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Redeem it' })).toHaveAttribute('href', '/redeem');
  });
});
