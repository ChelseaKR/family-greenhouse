import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HouseholdPage } from '@/features/household/HouseholdPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HouseholdPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('HouseholdPage', () => {
  beforeEach(() => {
    // A plain member (not admin) — the roster is visible to everyone in the
    // household, so this is the caller the privacy bug actually affected.
    useAuthStore.setState({
      isAuthenticated: true,
      idToken: 'id-token-1',
      refreshToken: 'refresh-1',
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'member',
      },
    } as never);

    server.use(
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          id: 'hh-1',
          name: 'The Kelly-Reifs',
          createdAt: '',
          createdBy: 'user-1',
          members: [
            {
              userId: 'user-1',
              name: 'Alice',
              // Defense-in-depth: even if a response somehow still carried an
              // email, the page must never render it.
              email: 'alice@example.com',
              role: 'member',
              joinedAt: '',
            },
            {
              userId: 'user-2',
              name: 'Bob',
              email: 'bob@example.com',
              role: 'admin',
              joinedAt: '',
            },
          ],
        })
      ),
      http.get(`${API}/tasks/vacation`, () => HttpResponse.json([])),
      // The care-split card reads the household's own activity feed and task
      // list — both already member-visible, neither previously fetched here.
      http.get(`${API}/households/hh-1/activity`, () => HttpResponse.json([])),
      http.get(`${API}/tasks`, () => HttpResponse.json([])),
      // The admin-only auto-handoff card reads the plan catalog + subscription.
      http.get(`${API}/billing/plans`, () =>
        HttpResponse.json({
          paymentsAvailable: false,
          commercialHold: { active: false, effectiveDate: '' },
          plans: [
            {
              id: 'seedling',
              name: 'Seedling',
              description: '',
              maxPlants: 10,
              maxMembers: 6,
              householdToolkit: false,
            },
            {
              id: 'garden',
              name: 'Garden',
              description: '',
              maxPlants: 500,
              maxMembers: 6,
              householdToolkit: true,
            },
          ],
        })
      ),
      http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'seedling' })),
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([
          { householdId: 'hh-1', name: 'The Kelly-Reifs', role: 'member', joinedAt: '' },
        ])
      )
    );
  });

  it('renders member names but never their email addresses', async () => {
    renderPage();

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
  });

  it('flags a member whose email is bouncing, without naming the address', async () => {
    server.use(
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          id: 'hh-1',
          name: 'The Kelly-Reifs',
          createdAt: '',
          createdBy: 'user-1',
          members: [
            { userId: 'user-1', name: 'Alice', role: 'member', joinedAt: '', emailStatus: 'ok' },
            {
              userId: 'user-2',
              name: 'Bob',
              role: 'admin',
              joinedAt: '',
              emailStatus: 'undeliverable',
            },
          ],
        })
      )
    );

    renderPage();

    // Exactly one badge — the member who is actually unreachable. Before this
    // the failure was invisible: the roster looked identical either way.
    expect(await screen.findByText('Email not arriving')).toBeInTheDocument();
    expect(screen.getAllByText('Email not arriving')).toHaveLength(1);
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
  });

  it('shows no badge for `unknown` — a failed check is not an accusation', async () => {
    server.use(
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          id: 'hh-1',
          name: 'The Kelly-Reifs',
          createdAt: '',
          createdBy: 'user-1',
          members: [
            {
              userId: 'user-1',
              name: 'Alice',
              role: 'member',
              joinedAt: '',
              emailStatus: 'unknown',
            },
          ],
        })
      )
    );

    renderPage();

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    // Telling the household "Alice is unreachable" on the strength of a failed
    // lookup would be the same defect in the other direction.
    expect(screen.queryByText('Email not arriving')).not.toBeInTheDocument();
  });

  it('shows every member the same care split, admin or not', async () => {
    renderPage();

    // The caller here is a plain member: the split is shared visibility, not
    // an admin report.
    expect(await screen.findByText('Who’s carrying the care')).toBeInTheDocument();
    const rows = await screen.findAllByRole('rowheader');
    expect(rows.map((row) => row.textContent)).toEqual(['Alice (you)', 'Bob']);
  });

  /** Admin caller — the invite card is admin-only, like the link generator. */
  function becomeAdmin() {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
    } as never);
    server.use(
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([
          { householdId: 'hh-1', name: 'The Kelly-Reifs', role: 'admin', joinedAt: '' },
        ])
      ),
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({ configured: false, location: null, weather: null, tips: [] })
      )
    );
  }

  it('emails an invite and shows the link alongside the confirmation', async () => {
    becomeAdmin();
    let received: unknown = null;
    server.use(
      http.post(`${API}/households/hh-1/invites/email`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json(
          {
            code: 'ABC',
            expiresAt: '2099-01-01T00:00:00.000Z',
            url: 'http://localhost:3000/join/ABC',
            status: 'accepted',
          },
          { status: 201 }
        );
      })
    );
    const user = userEvent.setup();
    renderPage();

    await user.type(
      await screen.findByLabelText('Send an invitation by email'),
      'friend@example.com'
    );
    await user.click(screen.getByRole('button', { name: /Send invite/i }));

    expect(await screen.findByText(/Invitation sent/i)).toBeInTheDocument();
    expect(received).toMatchObject({ email: 'friend@example.com' });
    // The copyable link is still offered — the email is the fast path, not the
    // only one.
    await waitFor(() =>
      expect(screen.getByLabelText('Invite link')).toHaveValue('http://localhost:3000/join/ABC')
    );
  });

  it('never claims a send that did not happen, and still hands over the link', async () => {
    becomeAdmin();
    server.use(
      http.post(`${API}/households/hh-1/invites/email`, () =>
        HttpResponse.json(
          {
            code: 'ABC',
            expiresAt: '2099-01-01T00:00:00.000Z',
            url: 'http://localhost:3000/join/ABC',
            status: 'unavailable',
          },
          { status: 201 }
        )
      )
    );
    const user = userEvent.setup();
    renderPage();

    await user.type(
      await screen.findByLabelText('Send an invitation by email'),
      'friend@example.com'
    );
    await user.click(screen.getByRole('button', { name: /Send invite/i }));

    expect(await screen.findByText(/couldn't send that email/i)).toBeInTheDocument();
    expect(screen.queryByText(/Invitation sent/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Invite link')).toHaveValue('http://localhost:3000/join/ABC');
  });

  it('surfaces the daily-cap refusal rather than pretending it sent', async () => {
    becomeAdmin();
    server.use(
      http.post(`${API}/households/hh-1/invites/email`, () =>
        HttpResponse.json(
          { message: 'This household has sent its 10 invite emails for today.' },
          { status: 429 }
        )
      )
    );
    const user = userEvent.setup();
    renderPage();

    await user.type(
      await screen.findByLabelText('Send an invitation by email'),
      'friend@example.com'
    );
    await user.click(screen.getByRole('button', { name: /Send invite/i }));

    expect(await screen.findByText(/10 invite emails for today/i)).toBeInTheDocument();
    expect(screen.queryByText(/Invitation sent/i)).not.toBeInTheDocument();
  });

  it('does not offer a dead location form when the climate provider is unavailable', async () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
    } as never);
    server.use(
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([
          { householdId: 'hh-1', name: 'The Kelly-Reifs', role: 'admin', joinedAt: '' },
        ])
      ),
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({ configured: false, location: null, weather: null, tips: [] })
      )
    );

    renderPage();

    expect(
      await screen.findByText(/Climate-aware tips are unavailable right now/i)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('City')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save location' })).not.toBeInTheDocument();
  });

  it('offers location setup when the climate provider is configured', async () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
    } as never);
    server.use(
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([
          { householdId: 'hh-1', name: 'The Kelly-Reifs', role: 'admin', joinedAt: '' },
        ])
      ),
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({ configured: true, location: null, weather: null, tips: [] })
      )
    );

    renderPage();

    expect(await screen.findByLabelText('City')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled();
  });
});
