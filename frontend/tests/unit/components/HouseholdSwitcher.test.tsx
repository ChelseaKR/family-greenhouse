import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HouseholdSwitcher } from '@/components/HouseholdSwitcher';
import { useAuthStore } from '@/store/authStore';
import * as householdService from '@/services/householdService';
import type { Membership } from '@/services/householdService';

vi.mock('@/services/analytics', () => ({
  track: vi.fn(),
  // authStore.setActiveHouseholdId now pins the analytics household group.
  setActiveHousehold: vi.fn(),
  identify: vi.fn(),
  setTelemetryAuthToken: vi.fn(),
  reset: vi.fn(),
}));

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateSpy };
});

const memberships: Membership[] = [
  { householdId: 'hh-default', name: 'Home', role: 'admin', joinedAt: '' },
  { householdId: 'hh-other', name: 'Lake House', role: 'member', joinedAt: '' },
];

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HouseholdSwitcher />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { invalidateSpy };
}

describe('HouseholdSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(householdService, 'listMyHouseholds').mockResolvedValue(memberships);
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'e',
        name: 'n',
        // The user's "home"/default household — switching back to it maps to null.
        householdId: 'hh-default',
        householdRole: 'admin',
      },
      idToken: 'id-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      isAuthenticated: true,
      isLoading: false,
      activeHouseholdId: null,
    });
  });

  it('renders nothing until memberships load and when there are none', () => {
    vi.spyOn(householdService, 'listMyHouseholds').mockResolvedValue([]);
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <HouseholdSwitcher />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('sets activeHouseholdId to the picked household when switching away from the default', async () => {
    setup();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText('Lake House')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Lake House/ }));

    expect(useAuthStore.getState().activeHouseholdId).toBe('hh-other');
  });

  it('maps the user’s own (default) household back to null, not the literal id', async () => {
    // Start on the non-default household so picking the default is a real change.
    useAuthStore.setState({ activeHouseholdId: 'hh-other' });
    setup();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Home/ }));

    // householdId === user.householdId → null (falls back to the Cognito claim).
    expect(useAuthStore.getState().activeHouseholdId).toBeNull();
  });

  it('invalidates only queries whose key includes the newly-active household id', async () => {
    const { invalidateSpy } = setup();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText('Lake House')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Lake House/ }));

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    const arg = invalidateSpy.mock.calls[0][0] as {
      predicate: (q: { queryKey: unknown[] }) => boolean;
    };
    expect(typeof arg.predicate).toBe('function');
    // The predicate matches the switched-to household's keys…
    expect(arg.predicate({ queryKey: ['plants', 'hh-other'] })).toBe(true);
    expect(arg.predicate({ queryKey: ['tasks', 'hh-other', 'upcoming'] })).toBe(true);
    // …and leaves an unrelated household's cache alone.
    expect(arg.predicate({ queryKey: ['plants', 'hh-default'] })).toBe(false);
    expect(arg.predicate({ queryKey: ['me', 'households'] })).toBe(false);
  });
});
