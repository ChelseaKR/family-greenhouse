import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JoinHouseholdPage } from '@/features/household/JoinHouseholdPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderJoin(code: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/join/${code}`]}>
        <Routes>
          <Route path="/join/:inviteCode" element={<JoinHouseholdPage />} />
          <Route path="/" element={<div>Home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('JoinHouseholdPage', () => {
  beforeEach(() => {
    // Authenticated user with NO household yet, holding a token minted before
    // the join (so it lacks the custom:household_id claim).
    useAuthStore.setState({
      isAuthenticated: true,
      idToken: 'stale-id-token',
      refreshToken: 'refresh-1',
      user: {
        id: 'u-briki',
        email: 'briki@example.com',
        householdId: null,
        householdRole: null,
      },
    } as never);
  });

  it('offers logged-out invitees existing-account sign-in only', async () => {
    useAuthStore.setState({ isAuthenticated: false, user: null } as never);
    server.use(
      http.get(`${API}/households/invites/code-public`, () =>
        HttpResponse.json({ valid: true, household: { id: 'hh-9', name: 'The Brikis' } })
      )
    );

    renderJoin('code-public');

    expect(await screen.findByText(/invited to join/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/login?redirect=/join/code-public'
    );
    expect(screen.queryByRole('button', { name: /create account/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/register"]')).toBeNull();
    expect(
      screen.getByRole('heading', {
        name: /new registration and commercial activity are paused/i,
      })
    ).toBeInTheDocument();
  });

  it('refreshes the token after joining so the new household claim lands (the add-plant 403 fix)', async () => {
    let refreshCalls = 0;
    server.use(
      http.get(`${API}/households/invites/code-1`, () =>
        HttpResponse.json({ valid: true, household: { id: 'hh-9', name: 'The Brikis' } })
      ),
      http.post(`${API}/households/join/code-1`, () =>
        HttpResponse.json({ id: 'hh-9', name: 'The Brikis' })
      ),
      http.post(`${API}/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json({
          idToken: 'fresh-id-token',
          accessToken: 'fresh-access',
          refreshToken: 'refresh-2',
        });
      })
    );

    renderJoin('code-1');
    await userEvent.click(await screen.findByRole('button', { name: /join household/i }));

    // The fix: the token is refreshed, so the next request (e.g. POST /plants)
    // carries the custom:household_id claim the join just wrote — instead of
    // 403 "User must belong to a household".
    await waitFor(() => expect(useAuthStore.getState().idToken).toBe('fresh-id-token'));
    expect(refreshCalls).toBe(1);
    expect(useAuthStore.getState().user?.householdId).toBe('hh-9');
  });

  it('still completes the join when the token refresh fails (best-effort)', async () => {
    server.use(
      http.get(`${API}/households/invites/code-2`, () =>
        HttpResponse.json({ valid: true, household: { id: 'hh-7', name: 'Fallback House' } })
      ),
      http.post(`${API}/households/join/code-2`, () =>
        HttpResponse.json({ id: 'hh-7', name: 'Fallback House' })
      ),
      http.post(`${API}/auth/refresh`, () =>
        HttpResponse.json({ message: 'nope' }, { status: 401 })
      )
    );

    renderJoin('code-2');
    await userEvent.click(await screen.findByRole('button', { name: /join household/i }));

    // Membership is recorded locally even if the refresh hiccups; the auth
    // interceptor recovers on the next 401.
    await waitFor(() => expect(useAuthStore.getState().user?.householdId).toBe('hh-7'));
  });

  describe('a user who already belongs to a household opens an invite to a DIFFERENT one', () => {
    beforeEach(() => {
      // The common case this page used to get wrong: almost every onboarded
      // user has a default household via the Cognito claim.
      useAuthStore.setState({
        isAuthenticated: true,
        idToken: 'id-token',
        refreshToken: 'refresh-1',
        user: {
          id: 'u-briki',
          email: 'briki@example.com',
          householdId: 'hh-existing',
          householdRole: 'member',
        },
      } as never);
    });

    it('shows the Join screen (not a redirect) and can accept a second household', async () => {
      server.use(
        http.get(`${API}/households/invites/code-3`, () =>
          HttpResponse.json({ valid: true, household: { id: 'hh-new', name: 'Second House' } })
        ),
        // The invited household ("hh-new") is NOT among this user's existing
        // memberships ("hh-existing") — must NOT be treated as already-joined.
        http.get(`${API}/me/households`, () =>
          HttpResponse.json([
            { householdId: 'hh-existing', name: 'First House', role: 'member', joinedAt: '' },
          ])
        ),
        http.post(`${API}/households/join/code-3`, () =>
          HttpResponse.json({ id: 'hh-new', name: 'Second House' })
        )
      );

      renderJoin('code-3');

      // Regression guard: the old blanket "user?.householdId is set → redirect"
      // check would have bounced to Home before this ever rendered.
      expect(await screen.findByText('Second House')).toBeInTheDocument();
      const joinButton = screen.getByRole('button', { name: /join household/i });

      await userEvent.click(joinButton);
      await waitFor(() => expect(useAuthStore.getState().user?.householdId).toBe('hh-new'));
    });

    it('shows an "already a member" message instead of the Join button when the invite targets a household they\'re already in', async () => {
      server.use(
        http.get(`${API}/households/invites/code-4`, () =>
          HttpResponse.json({ valid: true, household: { id: 'hh-existing', name: 'First House' } })
        ),
        http.get(`${API}/me/households`, () =>
          HttpResponse.json([
            { householdId: 'hh-existing', name: 'First House', role: 'member', joinedAt: '' },
          ])
        )
      );

      renderJoin('code-4');

      expect(await screen.findByText(/already a member/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /join household/i })).not.toBeInTheDocument();
    });
  });
});
