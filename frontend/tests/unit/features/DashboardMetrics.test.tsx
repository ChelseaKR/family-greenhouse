import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * The dashboard's status line is the same absence-as-zero shape as the plan
 * meters in #308: a failed plants/tasks read used to publish the number 0 —
 * "Plants 0", "Overdue 0" — which reads as "you have no plants" and "nothing
 * needs you today". Unknown must render as unknown.
 */
function renderDashboard({ failing }: { failing: boolean }) {
  const list = (body: unknown) =>
    failing
      ? () => new HttpResponse(null, { status: 500 })
      : () => HttpResponse.json(body as never);

  server.use(
    http.get(`${API}/tasks/upcoming`, list([])),
    http.get(`${API}/tasks`, list([])),
    http.get(`${API}/plants`, list([])),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'user-1',
        members: [{ userId: 'user-1', name: 'Chelsea', role: 'admin', joinedAt: '' }],
      })
    ),
    http.get(`${API}/households/hh-1/activity`, () => HttpResponse.json([])),
    http.get(`${API}/households/hh-1/climate`, () => HttpResponse.json({ status: 'no_location' })),
    http.get(`${API}/households/hh-1/year-in-review`, () =>
      HttpResponse.json({
        year: 2026,
        totalCompletions: 0,
        byMember: [],
        byTaskType: [],
        topPlants: [],
      })
    )
  );
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

describe('dashboard status metrics', () => {
  it('renders a genuine empty household as zero', async () => {
    const { container } = renderDashboard({ failing: false });
    await screen.findByText('No tasks yet');

    const metrics = within(container.querySelector('dl') as HTMLElement);
    expect(metrics.getAllByText('0')).toHaveLength(3);
    expect(metrics.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders unknown counts as unknown when the reads fail, never as zero', async () => {
    const { container } = renderDashboard({ failing: true });
    // Both list sections surface their own error alert; wait for those so the
    // assertion below is about the settled state, not the loading one.
    await screen.findAllByRole('alert');

    const metrics = within(container.querySelector('dl') as HTMLElement);
    expect(metrics.queryByText('0')).not.toBeInTheDocument();
    expect(metrics.getAllByText('—')).toHaveLength(3);
  });
});
