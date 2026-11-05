/**
 * The "To do now" card when nothing is due in the next 7 days (quality audit
 * 2026-11-05, finding 5). Right after a first plant with a 14-day reminder,
 * the dashboard used to say "No tasks yet. Add tasks to your plants", because
 * it decided from `GET /tasks/upcoming` (7 days) alone. It now reads the
 * whole schedule before saying there are no tasks.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const DAY_MS = 86_400_000;

function task(id: string, plantName: string, inDays: number) {
  return {
    id,
    plantId: `p-${id}`,
    plantName,
    type: 'water',
    frequency: 14,
    lastCompleted: null,
    nextDue: new Date(Date.now() + inDays * DAY_MS).toISOString(),
    assignedTo: null,
    assignedToName: null,
    notes: null,
  };
}

function renderDashboard({
  upcoming = [] as unknown[],
  all = [] as unknown[] | 'fail',
}: { upcoming?: unknown[]; all?: unknown[] | 'fail' } = {}) {
  let fullReads = 0;
  server.use(
    http.get(`${API}/tasks/upcoming`, () => HttpResponse.json(upcoming as never)),
    http.get(`${API}/tasks`, () => {
      fullReads += 1;
      return all === 'fail'
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json(all as never);
    }),
    http.get(`${API}/plants`, () =>
      HttpResponse.json([{ id: 'p-1', name: 'ZZ plant', householdId: 'hh-1' }])
    ),
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' }])
    ),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'user-1',
        members: [{ userId: 'user-1', name: 'Sam', role: 'admin', joinedAt: '' }],
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
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { fullReads: () => fullReads };
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  useAuthStore.setState({
    user: {
      id: 'user-1',
      email: 'sam@example.com',
      name: 'Sam',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    isAuthenticated: true,
    isLoading: false,
  } as never);
});

describe('dashboard: nothing due this week', () => {
  it('names the next task instead of "No tasks yet" when the only task is two weeks out', async () => {
    const due = task('t1', 'ZZ plant', 14);
    renderDashboard({ all: [task('t2', 'Jade plant', 20), due] });

    expect(await screen.findByText('Nothing due this week')).toBeVisible();
    const date = new Date(due.nextDue).toLocaleDateString('en', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    expect(screen.getByText(`Next: ZZ plant, ${date}.`)).toBeVisible();
    expect(screen.getByRole('link', { name: 'View all tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.queryByText('No tasks yet')).toBeNull();
    expect(screen.queryByText(/add tasks to your plants/i)).toBeNull();
  });

  it('still says "No tasks yet" when the whole schedule really is empty (negative control)', async () => {
    const { fullReads } = renderDashboard({ all: [] });

    expect(await screen.findByText('No tasks yet')).toBeVisible();
    // The control applied: the full schedule was read, not assumed.
    expect(fullReads()).toBeGreaterThan(0);
    expect(screen.queryByText('Nothing due this week')).toBeNull();
  });

  it('never says "No tasks yet" when the full schedule cannot be read', async () => {
    const { fullReads } = renderDashboard({ all: 'fail' });

    expect(await screen.findByText('Nothing is due in the next 7 days.')).toBeVisible();
    expect(fullReads()).toBeGreaterThan(0);
    expect(screen.queryByText('No tasks yet')).toBeNull();
    expect(screen.queryByText(/^Next:/)).toBeNull();
  });

  it('keeps the later-this-week state when something is due in the 7-day window', async () => {
    renderDashboard({
      upcoming: [task('t1', 'ZZ plant', 3)],
      all: [task('t1', 'ZZ plant', 3)],
    });

    expect(await screen.findByText('Nothing to do right now')).toBeVisible();
    expect(screen.queryByText('Nothing due this week')).toBeNull();
  });

  it('says it in Spanish', async () => {
    await ensureLanguageCatalog('es');
    await i18n.changeLanguage('es');
    renderDashboard({ all: [task('t1', 'Zamioculca', 14)] });

    expect(await screen.findByText('Nada pendiente esta semana')).toBeVisible();
    expect(screen.getByText(/^Próxima: Zamioculca, /)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver todas las tareas' })).toBeVisible();
  });
});
