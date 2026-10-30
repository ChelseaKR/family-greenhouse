/**
 * The houseplant shortcut in the dashboard's empty "Your plants" card
 * (2026-10-24). This is where a household that skipped, or predates, the
 * first run meets it: 37 of 43 households had no plants on 2026-10-23.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { useAuthStore } from '@/store/authStore';
import { trackGoogleConversion } from '@/services/googleAnalytics';
import { server } from '../../msw/server';

vi.mock('@/services/googleAnalytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/googleAnalytics')>();
  return { ...actual, trackGoogleConversion: vi.fn() };
});

const API = 'http://localhost:4000';

interface Setup {
  /** The role `/me/households` reports; 'fail' leaves it unreadable. */
  role?: 'admin' | 'member' | 'fail';
  /** The Cognito-claim role the store falls back to while that list loads. */
  claimRole?: 'admin' | 'member' | null;
  plants?: unknown[];
}

function renderDashboard({ role = 'admin', claimRole = 'admin', plants = [] }: Setup = {}) {
  useAuthStore.setState({
    user: {
      id: 'user-1',
      email: 'sam@example.com',
      name: 'Sam',
      householdId: 'hh-1',
      householdRole: claimRole,
    },
    isAuthenticated: true,
    isLoading: false,
  } as never);
  let plantList = plants;
  const created: Array<Record<string, unknown>> = [];
  const tasks: Array<Record<string, unknown>> = [];
  let membershipReads = 0;
  server.use(
    http.get(`${API}/me/households`, () => {
      membershipReads += 1;
      return role === 'fail'
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role, joinedAt: '' }]);
    }),
    http.get(`${API}/tasks/upcoming`, () => HttpResponse.json([])),
    http.get(`${API}/tasks`, () => HttpResponse.json([])),
    http.get(`${API}/plants`, () => HttpResponse.json(plantList)),
    http.post(`${API}/plants`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      created.push(body);
      const plant = { id: 'p-new', householdId: 'hh-1', ...body };
      plantList = [plant];
      return HttpResponse.json(plant);
    }),
    http.post(`${API}/tasks`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      tasks.push(body);
      return HttpResponse.json({ id: 't-new', ...body });
    }),
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
    http.get(`${API}/households/hh-1/sitter-links`, () => HttpResponse.json([])),
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
    http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'seedling' })),
    http.get(`${API}/billing/plans`, () =>
      HttpResponse.json({ paymentsAvailable: false, plans: [] })
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
  return { created, tasks, membershipReads: () => membershipReads };
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.mocked(trackGoogleConversion).mockClear();
});

describe('dashboard empty state: common-plant picker', () => {
  it('adds a tapped plant with its reminder and reports dashboard_empty', async () => {
    const user = userEvent.setup();
    const { created, tasks } = renderDashboard();

    const picker = await screen.findByTestId('dashboard-empty-picker');
    expect(
      within(picker).getByRole('heading', { name: /pick a common houseplant/i })
    ).toBeVisible();
    await user.click(within(picker).getByRole('button', { name: 'ZZ plant' }));

    // The card refills from the refreshed read and the picker goes away.
    await waitFor(() => expect(screen.queryByTestId('dashboard-empty-picker')).toBeNull());
    expect(created).toEqual([{ name: 'ZZ plant', species: 'Zamioculcas zamiifolia' }]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ plantId: 'p-new', type: 'water', frequency: 14 });
    expect(vi.mocked(trackGoogleConversion).mock.calls).toEqual([
      [{ name: 'household_activated' }],
      [{ name: 'first_plant_added', method: 'dashboard_empty' }],
    ]);
  });

  it('keeps a way to add any other plant beside the shortcut', async () => {
    renderDashboard({ role: 'member', claimRole: 'member' });

    const picker = await screen.findByTestId('dashboard-empty-picker');
    expect(
      within(picker).getByRole('link', { name: /something else\? add any plant/i })
    ).toHaveAttribute('href', '/plants/new');
  });

  it('is not shown once the household has a plant (negative control)', async () => {
    renderDashboard({ plants: [{ id: 'p1', name: 'Pothos', householdId: 'hh-1' }] });

    // The control applied: the plant was read and is on the card.
    expect(await screen.findByText('Pothos')).toBeVisible();
    expect(screen.queryByTestId('dashboard-empty-picker')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ZZ plant' })).toBeNull();
  });

  it('is not shown when the caller’s role in the household cannot be read (negative control)', async () => {
    const { membershipReads, created } = renderDashboard({ role: 'fail', claimRole: null });

    // The control applied: the empty household is shown, with the plain link,
    // and the membership read was made and refused.
    expect(await screen.findByText("Let's add your first plant")).toBeVisible();
    await waitFor(() => expect(membershipReads()).toBeGreaterThan(0));
    expect(screen.queryByTestId('dashboard-empty-picker')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pothos' })).toBeNull();
    expect(created).toEqual([]);
  });
});
