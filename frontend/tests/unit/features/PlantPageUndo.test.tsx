import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import { Toaster } from '@/components/Toaster';
import { UNDO_WINDOW_MS, resetDeferredCareQueueForTests } from '@/features/plants/deferredCare';
import { useAuthStore } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import { server } from '../../msw/server';

/**
 * "Same Undo everywhere": the plant page's Done buttons (the phone status
 * card's Watered, and each care task row's Done) wait out the same 5-second
 * Undo window as the Plants list. Every request that is not a GET is
 * recorded; "nothing written" means that list is empty.
 */
const API = 'http://localhost:4000';
let writes: string[] = [];

function dueIn(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 0, 0, 0);
  return d.toISOString();
}

function plantBody(careRule: string | null = null) {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Peace Lily',
    species: null,
    location: 'Bedroom',
    careRule,
    imageUrl: null,
    notes: null,
    createdAt: '2026-04-25T00:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-04-25T00:00:00.000Z',
    upcomingTasks: [
      {
        id: 't1',
        plantId: 'p1',
        plantName: 'Peace Lily',
        type: 'water',
        frequency: 7,
        lastCompleted: null,
        nextDue: dueIn(-1),
        assignedTo: null,
        assignedToName: null,
        notes: null,
        createdBy: 'u1',
        createdAt: '',
      },
    ],
    recentCompletions: [],
  };
}

function Away() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/tasks')}>
      leave
    </button>
  );
}

function renderPlant() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants/p1']}>
        <Away />
        <Routes>
          <Route path="/plants/:plantId" element={<PlantDetailPage />} />
          <Route path="/tasks" element={<p>Tasks page</p>} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const phone = (on: boolean) =>
  vi.fn().mockImplementation((query: string) => ({
    matches: on && query.includes('max-width: 639px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as never;

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetDeferredCareQueueForTests();
  useToastStore.setState({ toasts: [] });
  writes = [];
  window.matchMedia = phone(true);
  useAuthStore.setState({ accessToken: 'a', user: { id: 'u-me', householdId: 'hh-1' } as never });
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' && !path.startsWith('/telemetry')) {
      writes.push(`${request.method} ${path}`);
    }
  });
  server.use(
    http.get(`${API}/plants/p1`, () => HttpResponse.json(plantBody())),
    http.post(`${API}/tasks/t1/complete`, () => HttpResponse.json({}))
  );
});
afterEach(() => {
  server.events.removeAllListeners();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('the status card’s Watered', () => {
  it('writes nothing until the window has passed, then exactly one completion', async () => {
    const u = user();
    renderPlant();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    // The button became Undo, and the toast offers it too.
    expect(screen.getByRole('button', { name: 'Undo: Water Peace Lily' })).toBeInTheDocument();
    expect(screen.getByText('Done: Water, Peace Lily')).toBeInTheDocument();
    await pass(UNDO_WINDOW_MS - 100);
    expect(writes).toEqual([]);
    await pass(200);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
    await pass(UNDO_WINDOW_MS * 3);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
  });

  it('an undone water writes NOTHING (the card’s Undo)', async () => {
    const u = user();
    renderPlant();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    await pass(1500);
    await u.click(screen.getByRole('button', { name: 'Undo: Water Peace Lily' }));
    await pass(UNDO_WINDOW_MS * 3);
    expect(writes).toEqual([]);
    expect(screen.getByRole('button', { name: 'Water Peace Lily' })).toBeInTheDocument();
  });

  it('an undone water writes NOTHING (the toast’s Undo)', async () => {
    const u = user();
    renderPlant();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    const toasts = await screen.findByRole('region', { name: 'Notifications' });
    await u.click(await within(toasts).findByRole('button', { name: 'Undo' }));
    await pass(UNDO_WINDOW_MS * 3);
    expect(writes).toEqual([]);
  });

  it('the card and the task row are one pending completion, never two', async () => {
    const u = user();
    renderPlant();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    // The task row's Done for the same task is now Undo, not a second Done.
    const rowUndo = screen.getAllByRole('button', { name: 'Undo' });
    expect(rowUndo.length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    await pass(UNDO_WINDOW_MS + 100);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
  });

  it('leaving the page still commits exactly once', async () => {
    const u = user();
    renderPlant();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    await u.click(screen.getByRole('button', { name: 'leave' }));
    expect(await screen.findByText('Tasks page')).toBeInTheDocument();
    expect(writes).toEqual([]);
    await pass(UNDO_WINDOW_MS + 100);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
  });

  it('the app going to the background commits at once, and never again', async () => {
    const u = user();
    renderPlant();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
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
    server.use(
      http.get(`${API}/plants/p1`, () => HttpResponse.json(plantBody('Bottom-water this one.')))
    );
    const u = user();
    renderPlant();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Bottom-water this one.')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await pass(UNDO_WINDOW_MS * 2);
    expect(writes).toEqual([]);
  });
});

describe('a care task row’s Done (desktop too)', () => {
  it('waits out the same window, and Undo writes nothing', async () => {
    window.matchMedia = phone(false);
    const u = user();
    renderPlant();
    await u.click(await screen.findByRole('button', { name: 'Done' }));
    await pass(1000);
    expect(writes).toEqual([]);
    await u.click(screen.getAllByRole('button', { name: 'Undo' })[0]);
    await pass(UNDO_WINDOW_MS * 2);
    expect(writes).toEqual([]);

    await u.click(screen.getByRole('button', { name: 'Done' }));
    await pass(UNDO_WINDOW_MS + 100);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
  });
});
