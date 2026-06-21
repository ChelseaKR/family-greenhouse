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
});
