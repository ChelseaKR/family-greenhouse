import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * The analytics KPI tiles are the same absence-as-zero shape the dashboard
 * status line already fixed (see DashboardMetrics.test.tsx): a failed
 * plants/tasks/analytics read was coalesced with `?? []` and published as the
 * number 0 — "Plants 0", "Overdue now 0". Worse than the dashboard's version,
 * because `overdueTasks.length > 0` being false ALSO suppressed the amber
 * warning tone, so a broken fetch rendered as a confident, calm all-clear.
 *
 * Unknown must render as unknown, and unknown must never look reassuring.
 */
function renderAnalytics({ failing }: { failing: boolean }) {
  const ok = (body: unknown) =>
    failing
      ? () => new HttpResponse(null, { status: 500 })
      : () => HttpResponse.json(body as never);

  server.use(
    http.get(`${API}/plants`, ok([])),
    http.get(`${API}/tasks`, ok([])),
    http.get(`${API}/households/hh-1/analytics/daily`, ok({ series: [] })),
    http.get(
      `${API}/households/hh-1/year-in-review`,
      ok({ year: 2026, totalCompletions: 0, byMember: [], byTaskType: [], topPlants: [] })
    ),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'user-1',
        members: [{ userId: 'user-1', name: 'Chelsea', role: 'admin', joinedAt: '' }],
      })
    )
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/analytics']}>
        <AnalyticsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** The KPI row is the first grid under the page header. */
function kpiRow(container: HTMLElement) {
  const row = container.querySelector('div.grid');
  if (!row) throw new Error('KPI row not rendered');
  return row as HTMLElement;
}

/**
 * Settle signal that exists identically before and after this fix: the 30-day
 * card shows a spinner while `daily` is in flight and swaps it out once the
 * query settles either way. Waiting on THIS rather than on any post-fix copy
 * keeps every assertion below a statement about the settled render, so a
 * regression fails on the number itself rather than on a missing string.
 */
async function settled(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('svg.animate-spin')).toBeNull());
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  useAuthStore.setState({
    user: {
      id: 'user-1',
      email: 'chelsea@example.com',
      name: 'Chelsea',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    isAuthenticated: true,
    isLoading: false,
  } as never);
});

describe('analytics KPI tiles', () => {
  it('renders a genuine empty household as zero', async () => {
    const { container } = renderAnalytics({ failing: false });
    await settled(container);

    const tiles = within(kpiRow(container));
    await waitFor(() => expect(tiles.getAllByText('0')).toHaveLength(4));
    expect(tiles.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders unknown KPIs as unknown when the reads fail, never as zero', async () => {
    const { container } = renderAnalytics({ failing: true });
    await settled(container);

    const tiles = within(kpiRow(container));
    await waitFor(() => expect(tiles.getAllByText('—')).toHaveLength(4));
    expect(tiles.queryByText('0')).not.toBeInTheDocument();
  });

  it('does not dress a failed overdue read as a calm all-clear', async () => {
    const { container } = renderAnalytics({ failing: true });
    await settled(container);

    // The "Overdue now" tile must not render as a settled zero. The amber
    // warning styling is reserved for a real positive reading, and the plain
    // styling with a `0` in it is exactly the reassurance this bug invented.
    const overdue = within(kpiRow(container))
      .getByText('Overdue now')
      .closest('div') as HTMLElement;
    await waitFor(() => expect(within(overdue).getByText('—')).toBeInTheDocument());
    expect(within(overdue).queryByText('0')).not.toBeInTheDocument();
    expect(overdue).not.toHaveClass('bg-amber-50');
  });

  it('never claims a fabricated 30-day total when the analytics read fails', async () => {
    const { container } = renderAnalytics({ failing: true });
    await settled(container);

    // `series ?? []` drew a flat, empty chart whose own accessible label
    // asserted "total 0 tasks" — a whole month of doing nothing, invented
    // from a 500.
    expect(screen.queryByRole('img', { name: /30-day completion trend/i })).not.toBeInTheDocument();
  });

  it('still renders the real 30-day chart when the analytics read succeeds', async () => {
    const { container } = renderAnalytics({ failing: false });
    await settled(container);

    expect(screen.getByRole('img', { name: /30-day completion trend/i })).toBeInTheDocument();
  });
});
