import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * The dashboard's "due today" bucket must come from the calendar predicate,
 * not from the text of a label (#342).
 *
 * It used to be `formatDueDate(task.nextDue) === 'Today'`. `formatDueDate`
 * returns an English display string, so the partition was one translation or
 * one rewording away from moving every task out of "due today" with nothing
 * failing. Here the label is replaced with what a translated one would say,
 * and the count must not move.
 */
vi.mock('@/utils/date', async () => {
  const actual = await vi.importActual<typeof import('@/utils/date')>('@/utils/date');
  return { ...actual, formatDueDate: vi.fn(() => 'Hoy') };
});

const API = 'http://localhost:4000';

// Only `Date` is faked, so msw and react-query keep their real timers. Noon
// on a fixed day, so "later today" can never cross midnight mid-test.
const NOW = new Date(2026, 5, 9, 12, 0, 0, 0);
const LATER_TODAY = new Date(2026, 5, 9, 18, 0, 0, 0).toISOString();

function renderDashboard(nextDue: string) {
  server.use(
    http.get(`${API}/tasks/upcoming`, () =>
      HttpResponse.json([
        { id: 't1', plantId: 'p1', plantName: 'Monstera', type: 'water', nextDue, frequency: 7 },
      ])
    ),
    http.get(`${API}/tasks`, () => HttpResponse.json([])),
    http.get(`${API}/plants`, () => HttpResponse.json([])),
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
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

afterEach(() => {
  vi.useRealTimers();
});

describe('dashboard "due today" partition (#342)', () => {
  it('counts a task due later today as due today whatever its label says', async () => {
    const { formatDueDate } = await import('@/utils/date');
    renderDashboard(LATER_TODAY);

    // The row renders with the substituted label, so the mock really is the
    // one the page used — without this, a mock that silently failed to apply
    // would leave the English label in place and the test would prove nothing.
    await screen.findByText('Hoy');
    expect(vi.mocked(formatDueDate)).toHaveBeenCalled();

    const dueToday = screen.getByText('Due today').closest('div') as HTMLElement;
    expect(within(dueToday).getByText('1')).toBeInTheDocument();
    const overdue = screen.getByText('Overdue').closest('div') as HTMLElement;
    expect(within(overdue).getByText('0')).toBeInTheDocument();
  });
});
