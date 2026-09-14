import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { TasksPage } from '@/features/tasks/TasksPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * A task row states where its plant is. Both pages read that from
 * `GET /plants`, keyed by plant id — and both used to fall through to
 * "Unplaced" whenever the plant was not in the map, which is exactly what a
 * failed read looks like from the inside. So a household that had spent
 * months organising its plants into rooms was told, on every row, with no
 * error beside it, that none of them had one. Same shape as #534 (rooms) and
 * #456, one query further out.
 *
 * `GET /tasks` succeeds in every case below, so the schedule renders and the
 * rows are really there to read.
 */
const task = {
  id: 't-1',
  plantId: 'p-1',
  plantName: 'Monstera',
  type: 'water',
  customType: null,
  frequency: 7,
  lastCompleted: null,
  nextDue: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
};

/** The dashboard queue is overdue + today only, so its copy is due now. */
const dueTodayTask = { ...task, nextDue: new Date().toISOString() };

function baseHandlers(plants: () => HttpResponse | Response) {
  return [
    http.get(`${API}/tasks`, () => HttpResponse.json([task])),
    http.get(`${API}/tasks/upcoming`, () => HttpResponse.json([dueTodayTask])),
    http.get(`${API}/plants`, plants),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'u1',
        members: [{ userId: 'u1', name: 'Someone', role: 'admin', joinedAt: '' }],
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
    ),
  ];
}

function renderPage(Page: () => JSX.Element, path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'someone@example.invalid',
      name: 'Someone',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    accessToken: 'access-1',
    isAuthenticated: true,
    isLoading: false,
  } as never);
});

describe('a task row when the plants read failed', () => {
  it('says the room is unknown on /tasks, not that the plant is unplaced', async () => {
    server.use(...baseHandlers(() => new HttpResponse(null, { status: 500 })));
    renderPage(TasksPage, '/tasks');

    expect(await screen.findByText('Monstera')).toBeInTheDocument();
    expect(await screen.findByText('Room unknown')).toBeInTheDocument();
    expect(screen.queryByText('Unplaced')).not.toBeInTheDocument();
  });

  it('says the room is unknown on the dashboard queue too', async () => {
    server.use(...baseHandlers(() => new HttpResponse(null, { status: 500 })));
    renderPage(DashboardPage, '/dashboard');

    expect(await screen.findByText('Room unknown')).toBeInTheDocument();
    expect(screen.queryByText('Unplaced')).not.toBeInTheDocument();
  });

  it('still says "Unplaced" when the read succeeded and the plant genuinely has no room', async () => {
    server.use(
      ...baseHandlers(() =>
        HttpResponse.json([
          {
            id: 'p-1',
            name: 'Monstera',
            species: null,
            spaceId: null,
            location: null,
            placementNote: null,
            createdAt: '',
          },
        ])
      )
    );
    renderPage(TasksPage, '/tasks');

    expect(await screen.findByText('Unplaced')).toBeInTheDocument();
    expect(screen.queryByText('Room unknown')).not.toBeInTheDocument();
  });
});
