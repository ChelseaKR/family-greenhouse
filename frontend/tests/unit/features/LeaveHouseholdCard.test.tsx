import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe, toHaveNoViolations } from 'jest-axe';
import { LeaveHouseholdCard } from '@/features/household/LeaveHouseholdCard';
import type { HouseholdMember } from '@/services/householdService';
import { useAuthStore } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import { server } from '../../msw/server';

expect.extend(toHaveNoViolations);

declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
}

const API = 'http://localhost:4000';

const me = (role: 'admin' | 'member'): HouseholdMember => ({
  userId: 'user-1',
  name: 'Alice',
  role,
  joinedAt: '',
});
const other = (userId: string, role: 'admin' | 'member'): HouseholdMember => ({
  userId,
  name: userId,
  role,
  joinedAt: '',
});

const leftResult = {
  householdId: 'hh-2',
  releasedTasks: 1,
  revokedCredentials: { plantTags: 0, sitterLinks: 0, kioskLinks: 0, cuttingShares: 0 },
  defaultHouseholdId: 'hh-1',
  defaultHouseholdRole: 'admin',
  remainingHouseholds: 1,
};

function renderCard(members: HouseholdMember[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/household']}>
        <Routes>
          <Route
            path="/household"
            element={
              <LeaveHouseholdCard
                householdId="hh-2"
                householdName="Maple Street"
                members={members}
              />
            }
          />
          <Route path="/dashboard" element={<p>dashboard page</p>} />
          <Route path="/onboarding" element={<p>onboarding page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('LeaveHouseholdCard (#686)', () => {
  let leaveBodies: unknown[];

  beforeEach(() => {
    leaveBodies = [];
    useToastStore.setState({ toasts: [] });
    useAuthStore.setState({
      isAuthenticated: true,
      idToken: 'id-token-1',
      refreshToken: null,
      activeHouseholdId: 'hh-2',
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
    } as never);
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('assignedTo')).toBe('user-1');
        return HttpResponse.json([{ id: 't1' }, { id: 't2' }]);
      })
    );
  });

  function onLeave(respond: (body: unknown) => Response) {
    server.use(
      http.post(`${API}/households/hh-2/leave`, async ({ request }) => {
        const body = await request.json();
        leaveBodies.push(body);
        return respond(body);
      })
    );
  }

  it('says why the only member cannot leave, and offers no button that would be refused', async () => {
    renderCard([me('admin')]);
    expect(screen.getByText(/You’re the only member/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave household' })).toBeDisabled();
  });

  it('says why the only admin cannot leave', () => {
    renderCard([me('admin'), other('user-2', 'member')]);
    expect(screen.getByText(/You’re the only admin/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave household' })).toBeDisabled();
  });

  it('tells a member how many tasks go back up for grabs before they confirm, then leaves and lands on their remaining household', async () => {
    onLeave(() => HttpResponse.json(leftResult));
    const user = userEvent.setup();
    renderCard([me('member'), other('user-2', 'admin')]);

    await user.click(screen.getByRole('button', { name: 'Leave household' }));
    expect(await screen.findByText(/You have 2 tasks with your name on them/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Leave Maple Street?' })).toBeInTheDocument();
    // Focus starts on the safe choice.
    expect(screen.getByRole('button', { name: 'Stay' })).toHaveFocus();

    const dialogButtons = screen.getAllByRole('button', { name: 'Leave household' });
    await user.click(dialogButtons[dialogButtons.length - 1]);

    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
    expect(leaveBodies).toEqual([{}]);
    const state = useAuthStore.getState();
    expect(state.activeHouseholdId).toBeNull();
    expect(state.user?.householdId).toBe('hh-1');
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'You left Maple Street.'
    );
  });

  it('sends a leaver of their last household to onboarding', async () => {
    onLeave(() =>
      HttpResponse.json({
        ...leftResult,
        defaultHouseholdId: null,
        defaultHouseholdRole: null,
        remainingHouseholds: 0,
      })
    );
    const user = userEvent.setup();
    renderCard([me('member'), other('user-2', 'admin')]);
    await user.click(screen.getByRole('button', { name: 'Leave household' }));
    const dialogButtons = await screen.findAllByRole('button', { name: 'Leave household' });
    await user.click(dialogButtons[dialogButtons.length - 1]);
    expect(await screen.findByText('onboarding page')).toBeInTheDocument();
    expect(useAuthStore.getState().user?.householdId).toBeNull();
  });

  it('asks an admin of a renewing paid household to acknowledge billing, then re-sends with it', async () => {
    onLeave((body) =>
      (body as { acknowledgeBilling?: boolean }).acknowledgeBilling
        ? HttpResponse.json(leftResult)
        : HttpResponse.json(
            { message: 'renewing', details: { code: 'BILLING_ACK_REQUIRED' } },
            { status: 409 }
          )
    );
    const user = userEvent.setup();
    renderCard([me('admin'), other('user-2', 'admin')]);
    await user.click(screen.getByRole('button', { name: 'Leave household' }));
    const dialogButtons = await screen.findAllByRole('button', { name: 'Leave household' });
    await user.click(dialogButtons[dialogButtons.length - 1]);

    expect(
      await screen.findByRole('heading', { name: 'This household’s paid plan keeps renewing' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Leaving doesn’t cancel or change the plan/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }));

    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
    expect(leaveBodies).toEqual([{}, { acknowledgeBilling: true }]);
  });

  it('words a refusal the roster did not predict (a lost last-admin race) in the user’s language', async () => {
    onLeave(() =>
      HttpResponse.json({ message: 'x', details: { code: 'LAST_ADMIN' } }, { status: 409 })
    );
    const user = userEvent.setup();
    renderCard([me('admin'), other('user-2', 'admin')]);
    await user.click(screen.getByRole('button', { name: 'Leave household' }));
    const dialogButtons = await screen.findAllByRole('button', { name: 'Leave household' });
    await user.click(dialogButtons[dialogButtons.length - 1]);
    expect(await screen.findByText(/You’re the only admin/)).toBeInTheDocument();
    expect(screen.getByText('Leave this household')).toBeInTheDocument();
  });

  it('never says "0 tasks" when the task read failed', async () => {
    server.use(http.get(`${API}/tasks`, () => new HttpResponse(null, { status: 500 })));
    const user = userEvent.setup();
    renderCard([me('member'), other('user-2', 'admin')]);
    await user.click(screen.getByRole('button', { name: 'Leave household' }));
    await waitFor(() =>
      expect(
        screen.getByText(/Any tasks with your name on them go back up for grabs/)
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/You have 0 tasks/)).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderCard([me('member'), other('user-2', 'admin')]);
    expect(await axe(container)).toHaveNoViolations();
  });
});
