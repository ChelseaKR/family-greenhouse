import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * `/tasks/upcoming` stops at seven days. A household whose every task is
 * further out (a succulent watered every 14 days, monthly feeding, the day
 * after a round of care) used to be told "No tasks yet. Add tasks to your
 * plants." Only a household with no tasks at all may hear that.
 */
function task(overrides: Record<string, unknown>) {
  return {
    id: 't1',
    plantId: 'p1',
    plantName: 'Jade',
    type: 'water',
    frequency: 14,
    lastCompleted: null,
    nextDue: new Date(Date.now() + 12 * 86_400_000).toISOString(),
    assignedTo: null,
    assignedToName: null,
    notes: null,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderDashboard({ upcoming, all }: { upcoming: unknown[]; all: unknown[] | 'failing' }) {
  server.use(
    http.get(`${API}/tasks/upcoming`, () => HttpResponse.json(upcoming as never)),
    http.get(`${API}/tasks`, () =>
      all === 'failing' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(all as never)
    ),
    http.get(`${API}/plants`, () => HttpResponse.json([{ id: 'p1', name: 'Jade' }] as never)),
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

describe('dashboard empty week', () => {
  it('says nothing is due this week, and when the next task is, when tasks are all further out', async () => {
    const soon = task({ id: 't2', plantName: 'Aloe', nextDue: '2030-03-10T12:00:00.000Z' });
    const later = task({ id: 't3', type: 'fertilize', nextDue: '2030-04-01T12:00:00.000Z' });
    renderDashboard({ upcoming: [], all: [later, soon] });

    expect(await screen.findByText('Nothing due this week')).toBeInTheDocument();
    const expectedDate = new Date('2030-03-10T12:00:00.000Z').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    expect(await screen.findByText(`Next up: Water Aloe on ${expectedDate}.`)).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all tasks' })).toHaveAttribute('href', '/tasks');
  });

  it('never claims "No tasks yet" when the full task list could not be read', async () => {
    renderDashboard({ upcoming: [], all: 'failing' });

    expect(await screen.findByText('Nothing due this week')).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
  });

  it('still says "No tasks yet" to a household that really has none', async () => {
    renderDashboard({ upcoming: [], all: [] });

    expect(await screen.findByText('No tasks yet')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'View plants' })).toHaveAttribute(
      'href',
      '/plants'
    );
  });
});
