import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HouseholdOnboarding } from '@/features/household/HouseholdOnboarding';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * Ordering guard for the first-household claim race.
 *
 * POST /households writes `custom:household_id` to Cognito (awaited) before it
 * answers 201, so the token we hold at that moment is provably stale. The app
 * refreshes it — but WHERE that refresh sits relative to `setHousehold` is the
 * whole behaviour, and nothing pinned it.
 *
 * `setHousehold` flips `hasHousehold` in App.tsx, `OnboardingGate` redirects to
 * /welcome on that same render, and WelcomeFlow fires its plants query
 * synchronously. A refresh awaited AFTER the flip therefore cannot prevent the
 * 403 it exists to prevent — the request has already left. Measured against
 * deployed staging, that ordering produced a 403 on `GET /plants` on every run.
 *
 * These tests assert the invariant rather than the line order: at the instant
 * the refresh is requested, the store must NOT yet carry a household.
 */
function renderOnboarding() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <Routes>
          <Route path="/onboarding" element={<HouseholdOnboarding />} />
          <Route path="/" element={<div>Home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function createAHousehold() {
  const user = userEvent.setup();
  renderOnboarding();
  await user.click(await screen.findByRole('button', { name: /create a new household/i }));
  await user.type(await screen.findByLabelText(/household name/i), 'The Greenhouse');
  await user.click(screen.getByRole('button', { name: /create household/i }));
}

describe('HouseholdOnboarding — first-household claim race', () => {
  beforeEach(() => {
    // A signed-in user with NO household, holding a token minted before it.
    useAuthStore.setState({
      isAuthenticated: true,
      idToken: 'stale-id-token',
      accessToken: 'stale-access-token',
      refreshToken: 'refresh-1',
      user: {
        id: 'u-1',
        email: 'someone@example.com',
        householdId: null,
        householdRole: null,
      },
    } as never);
  });

  it('refreshes the token BEFORE the store gains a household', async () => {
    let householdIdAtRefresh: string | null | undefined = 'never-refreshed';

    server.use(
      http.post(`${API}/households`, () =>
        HttpResponse.json({ id: 'hh-1', name: 'The Greenhouse' }, { status: 201 })
      ),
      http.post(`${API}/auth/refresh`, () => {
        // The observation that matters: the store must still be household-less
        // here. If it already has one, the redirect to /welcome has fired and
        // the first household-scoped request is already in flight on the stale
        // token — exactly the 403 measured against staging.
        householdIdAtRefresh = useAuthStore.getState().user?.householdId ?? null;
        return HttpResponse.json({
          idToken: 'fresh-id-token',
          accessToken: 'fresh-access-token',
          refreshToken: 'refresh-2',
        });
      })
    );

    await createAHousehold();

    await waitFor(() => expect(useAuthStore.getState().user?.householdId).toBe('hh-1'));

    expect(householdIdAtRefresh).toBeNull();
    // And the fresh token is the one in hand once the household lands.
    expect(useAuthStore.getState().idToken).toBe('fresh-id-token');
  });

  it('still adopts the household when the refresh fails, so onboarding cannot dead-end', async () => {
    server.use(
      http.post(`${API}/households`, () =>
        HttpResponse.json({ id: 'hh-2', name: 'The Greenhouse' }, { status: 201 })
      ),
      http.post(`${API}/auth/refresh`, () => HttpResponse.json({}, { status: 500 }))
    );

    await createAHousehold();

    // Best-effort by design: a failed refresh must not strand the user on the
    // onboarding form. The 401 interceptor recovers the token later.
    await waitFor(() => expect(useAuthStore.getState().user?.householdId).toBe('hh-2'));
    expect(useAuthStore.getState().idToken).toBe('stale-id-token');
  });
});
