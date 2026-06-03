import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../msw/server';

/**
 * Integration coverage for the dashboard journey end-to-end inside a
 * faked-out network. The dashboard touches several services (tasks,
 * plants, household activity, climate, year-in-review). MSW handlers
 * here register every endpoint each query hits so unhandled-request
 * errors don't cascade into a "query failed" empty state.
 *
 * Focus is on the user-visible flow: a task appears, the Done button
 * fires the mutation, the row leaves the list, the empty state lands.
 * Smaller assertions (chip styling, filter pills) are covered by the
 * frontend component unit tests, so they don't repeat here.
 */

const API = 'http://localhost:4000';

function renderDashboard() {
  // Each test gets a fresh QueryClient so React Query cache doesn't bleed
  // between cases. Retries off keeps assertion turnaround fast — a single
  // 4xx returns immediately rather than backing off three times.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  // Sign in a fake user before every test so the dashboard's
  // user-derived state (e.g. household id for the activity query)
  // resolves immediately.
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'test@example.com',
      name: 'Chelsea',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    accessToken: 'access-1',
    idToken: 'id-1',
    refreshToken: 'refresh-1',
    isAuthenticated: true,
    isLoading: false,
  });
});

describe('Dashboard integration', () => {
  it('completes a task and removes it from the list', async () => {
    let completed = false;
    server.use(
      http.get(`${API}/tasks/upcoming`, () => {
        // After completion, React Query invalidates this query and
        // refetches — return an empty list on the second hit so the row
        // drops out of the visible list as the user would experience.
        if (completed) return HttpResponse.json([]);
        return HttpResponse.json([
          {
            id: 't1',
            plantId: 'p1',
            plantName: 'Monstera',
            type: 'water',
            nextDue: new Date().toISOString(),
            frequency: 7,
          },
        ]);
      }),
      http.post(`${API}/tasks/t1/complete`, () => {
        completed = true;
        return HttpResponse.json({
          id: 't1',
          plantId: 'p1',
          plantName: 'Monstera',
          type: 'water',
          nextDue: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          frequency: 7,
        });
      }),
      http.get(`${API}/plants`, () => HttpResponse.json([])),
      http.get(`${API}/households/hh-1/activity`, () => HttpResponse.json([])),
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({ status: 'no_location' })
      ),
      http.get(`${API}/households/hh-1/year-in-review`, () =>
        HttpResponse.json({ year: 2026, plantsAdded: 0, tasksCompleted: 0 })
      )
    );

    const user = userEvent.setup();
    renderDashboard();

    // Wait for the task row to render — the Done button only mounts
    // once the upcoming-tasks query has resolved with at least one row.
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

    await user.click(screen.getByRole('button', { name: /done/i }));

    // After mutation + invalidate, the row should disappear and the
    // empty-state copy "All caught up!" should appear in its place.
    await waitFor(
      () => {
        expect(screen.queryByRole('button', { name: /done/i })).not.toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });
});
