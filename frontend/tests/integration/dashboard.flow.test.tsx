import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
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
  it('completes a task and shows it moved to its next due date', async () => {
    let completed = false;
    const nextDueAfterCompletion = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    server.use(
      http.get(`${API}/tasks/upcoming`, () => {
        // The refetch returns the task AGAIN, with its new due date.
        //
        // This mock used to answer `[]` here, commented "so the row drops out
        // of the visible list as the user would experience". That was not what
        // the server does and not what users experienced. `getUpcomingTasks`
        // returns everything due within SEVEN DAYS, and completion advances
        // nextDue by the task's frequency, so a weekly task lands right back
        // inside the window. The optimistic update filtered the row out, this
        // mock agreed, and the pair passed — while in production the row
        // vanished on tap and reappeared a moment later, reading as "it didn't
        // save". A mock that invents server behaviour turns a test into
        // confirmation of the author's belief.
        if (completed) {
          return HttpResponse.json([
            {
              id: 't1',
              plantId: 'p1',
              plantName: 'Monstera',
              type: 'water',
              nextDue: nextDueAfterCompletion,
              frequency: 7,
            },
          ]);
        }
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
      http.get(`${API}/tasks`, () =>
        HttpResponse.json([
          {
            id: 't1',
            plantId: 'p1',
            plantName: 'Monstera',
            type: 'water',
            nextDue: new Date().toISOString(),
            frequency: 7,
          },
        ])
      ),
      http.get(`${API}/plants`, () => HttpResponse.json([])),
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          id: 'hh-1',
          name: 'Home',
          createdAt: '',
          createdBy: 'u1',
          members: [{ userId: 'u1', name: 'Chelsea', role: 'admin', joinedAt: '' }],
        })
      ),
      http.get(`${API}/households/hh-1/activity`, () => HttpResponse.json([])),
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({ status: 'no_location' })
      ),
      http.get(`${API}/households/hh-1/year-in-review`, () =>
        // Match the YearInReview contract: with no completions the card
        // hides itself (totalCompletions === 0). The previous mock shape
        // ({ plantsAdded, tasksCompleted }) left totalCompletions undefined,
        // slipping past the guard and crashing YearInReviewCard on
        // byTaskType.map — a latent bug surfaced by stricter unhandled-error
        // handling in vitest 3.
        HttpResponse.json({
          year: 2026,
          totalCompletions: 0,
          byMember: [],
          byTaskType: [],
          topPlants: [],
        })
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

    // The completion is recorded — that is the part a user must be able to
    // trust, and the part that looked broken.
    await waitFor(
      () => {
        expect(completed).toBe(true);
      },
      { timeout: 5000 }
    );

    // The row LEAVES this card, because the card lists what can be done now
    // and the task is no longer due today.
    //
    // This assertion was the exact opposite a commit ago, and the reason is
    // worth keeping. The first fix stopped the row vanishing-then-reappearing
    // by making it move to its new date — mechanically right, and it left the
    // real problem untouched: the server's upcoming window is seven days, so a
    // WEEKLY task lands straight back inside it and could never be cleared
    // from the dashboard at all. Marking done, refreshing, and still seeing
    // the task is what a household actually reported.
    // Wait for a POSITIVE end-state, never for the absence of something.
    //
    // `waitFor(() => expect(X).not.toBeInTheDocument())` passes on the first
    // tick where X happens to be missing — a transient re-render will do — so
    // it holds whatever the code does. Written that way, this assertion passed
    // even with the card deliberately reverted to rendering `laterTasks`,
    // which is the regression it exists to catch. A test that cannot fail is
    // worse than no test, and this file already carries one such lesson.
    //
    // The empty state's own copy is the settled signal: it can only render
    // once the refetch has landed and left nothing actionable.
    await waitFor(() => expect(screen.getByText(/nothing to do right now/i)).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Now the negatives mean something, because the card has finished.
    expect(screen.queryByRole('button', { name: /done/i })).not.toBeInTheDocument();
    // The week is not clear — the task still exists, due in seven days.
    // "All caught up" here would be the same class of lie as the vanishing row.
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    expect(screen.getByText(/coming up later this week/i)).toBeInTheDocument();
    // Three 5s `waitFor` budgets cannot fit inside vitest's 5s default test
    // timeout, so this test could only ever pass by finishing well under its
    // own stated allowances — it reported "Test timed out" rather than a
    // failed assertion whenever the machine was busy. The waits are still
    // individually bounded, so a condition that never becomes true still
    // fails; it now fails with the assertion that actually broke.
  }, 20000);
});
