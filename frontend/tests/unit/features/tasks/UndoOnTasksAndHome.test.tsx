import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delay, http, HttpResponse } from 'msw';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '@/features/tasks/TasksPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { Toaster } from '@/components/Toaster';
import { UNDO_WINDOW_MS, resetDeferredCareQueueForTests } from '@/features/plants/deferredCare';
import { useAuthStore, type User } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import { server } from '../../../msw/server';

/**
 * "Same Undo everywhere", on the Tasks tab and the Home dashboard: Done waits
 * out the shared 5-second Undo window. Every request that is not a GET is
 * recorded; "nothing written" means that list is empty.
 */
const API = 'http://localhost:4000';
let writes: string[] = [];

function dueToday() {
  const d = new Date();
  d.setHours(23, 0, 0, 0);
  return d.toISOString();
}

const task = () => ({
  id: 't1',
  plantId: 'p1',
  plantName: 'Calathea',
  type: 'water',
  customType: null,
  frequency: 7,
  lastCompleted: null,
  nextDue: dueToday(),
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
});

function serve(careRule: string | null = null) {
  const plant = {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Calathea',
    species: null,
    location: null,
    imageUrl: null,
    notes: null,
    careRule,
    createdAt: '',
    createdBy: 'u1',
    updatedAt: '',
  };
  server.use(
    http.get(`${API}/tasks`, async () => {
      await delay(25);
      return HttpResponse.json([task()]);
    }),
    http.get(`${API}/tasks/upcoming`, async () => {
      await delay(25);
      return HttpResponse.json([task()]);
    }),
    http.get(`${API}/plants`, () => HttpResponse.json([plant])),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'u1',
        members: [{ userId: 'u1', name: 'Me', role: 'admin', joinedAt: '' }],
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
    http.post(`${API}/tasks/t1/complete`, () => HttpResponse.json(task()))
  );
}

function renderPage(which: 'tasks' | 'home') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[which === 'tasks' ? '/tasks' : '/dashboard']}>
        {which === 'tasks' ? <TasksPage /> : <DashboardPage />}
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetDeferredCareQueueForTests();
  useToastStore.setState({ toasts: [] });
  writes = [];
  useAuthStore.setState({
    accessToken: 'access-1',
    user: { id: 'u1', email: 'me@example.com', name: 'Me', householdId: 'hh-1' } as User,
  });
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' && !path.startsWith('/telemetry')) {
      writes.push(`${request.method} ${path}`);
    }
  });
});
afterEach(() => {
  server.events.removeAllListeners();
  vi.useRealTimers();
});

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const done = () => screen.findByRole('button', { name: /^Done$/ });

describe.each(['tasks', 'home'] as const)('Done on the %s page', (which) => {
  it('writes nothing until the window has passed, then exactly one completion', async () => {
    serve();
    const u = user();
    renderPage(which);
    await u.click(await done());
    expect(screen.getByRole('button', { name: 'Undo: Water Calathea' })).toBeInTheDocument();
    await pass(UNDO_WINDOW_MS - 100);
    expect(writes).toEqual([]);
    await pass(200);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
    await pass(UNDO_WINDOW_MS * 3);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
  });

  it('an undone completion writes NOTHING (the row’s Undo)', async () => {
    serve();
    const u = user();
    renderPage(which);
    await u.click(await done());
    await pass(1500);
    await u.click(screen.getByRole('button', { name: 'Undo: Water Calathea' }));
    await pass(UNDO_WINDOW_MS * 3);
    expect(writes).toEqual([]);
    expect(await done()).toBeInTheDocument();
  });

  it('an undone completion writes NOTHING (the toast’s Undo)', async () => {
    serve();
    const u = user();
    renderPage(which);
    await u.click(await done());
    const toasts = await screen.findByRole('region', { name: 'Notifications' });
    await u.click(await within(toasts).findByRole('button', { name: 'Undo' }));
    await pass(UNDO_WINDOW_MS * 3);
    expect(writes).toEqual([]);
  });

  it('a second press is Undo, never a second completion', async () => {
    serve();
    const u = user();
    renderPage(which);
    const button = await done();
    await u.click(button);
    await u.click(button); // undo
    await u.click(button); // done again
    await pass(UNDO_WINDOW_MS + 100);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
  });

  it('the app going to the background commits at once, and never again', async () => {
    serve();
    const u = user();
    renderPage(which);
    await u.click(await done());
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    visibility.mockRestore();
    await pass(10);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
    await pass(UNDO_WINDOW_MS * 2);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
  });

  it('shows the house rule first; cancelling it writes nothing', async () => {
    serve('Bottom-water only');
    const u = user();
    renderPage(which);
    await u.click(await done());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Bottom-water only')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await pass(UNDO_WINDOW_MS * 2);
    expect(writes).toEqual([]);
  });
});
