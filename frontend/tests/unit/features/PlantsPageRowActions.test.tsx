import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantsPage } from '@/features/plants/PlantsPage';
import { Toaster } from '@/components/Toaster';
import { UNDO_WINDOW_MS, resetDeferredCareQueueForTests } from '@/features/plants/deferredCare';
import { useAuthStore } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import { server } from '../../msw/server';

/**
 * The Plants list's Done button, its Undo, the row menu and Snooze, checked
 * against the network: every request that is not a GET is recorded, and
 * "nothing written" means that list is empty. Fake timers stand in for the
 * 5-second Undo window.
 */
const API = 'http://localhost:4000';
const ME = 'u-me';
let writes: Array<{ what: string; body: unknown }> = [];

function plant(id: string, name: string, careRule: string | null = null) {
  return {
    id,
    householdId: 'hh-1',
    name,
    species: null,
    location: null,
    careRule,
    imageUrl: null,
    notes: null,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
  };
}
function task(id: string, plantId: string, days: number) {
  const due = new Date();
  due.setDate(due.getDate() + days);
  due.setHours(23, 0, 0, 0);
  return {
    id,
    plantId,
    plantName: plantId,
    type: 'water',
    frequency: 7,
    lastCompleted: null,
    nextDue: due.toISOString(),
    assignedTo: null,
    assignedToName: null,
    notes: null,
    createdBy: 'x',
    createdAt: '',
  };
}
const TASKS = [task('t1', 'p1', -1), task('t2', 'p2', 0), task('t3', 'p3', 4)];

function Away() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/tasks')}>
      leave
    </button>
  );
}

function renderPlants() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants']}>
        <Away />
        <Routes>
          <Route path="/plants" element={<PlantsPage />} />
          <Route path="/plants/:id" element={<div>Plant page</div>} />
          <Route path="/tasks" element={<div>Tasks page</div>} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetDeferredCareQueueForTests();
  useToastStore.setState({ toasts: [] });
  writes = [];
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('max-width: 639px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as never;
  useAuthStore.setState({ accessToken: 'a', user: { id: ME, householdId: 'hh-1' } as never });
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'GET') return;
    const url = new URL(request.url);
    if (url.pathname.startsWith('/telemetry')) return;
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => null);
    writes.push({ what: `${request.method} ${url.pathname}`, body });
  });
  server.use(
    http.get(`${API}/plants`, () =>
      HttpResponse.json([
        plant('p1', 'Peace Lily'),
        plant('p2', 'Monstera', 'Bottom-water this one.'),
        plant('p3', 'Snake Plant'),
      ])
    ),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/tasks`, () => HttpResponse.json(TASKS)),
    http.post(`${API}/tasks/:id/complete`, ({ params }) =>
      HttpResponse.json({
        ...TASKS.find((t) => t.id === params.id),
        nextDue: '2099-01-01T00:00:00Z',
      })
    ),
    http.post(`${API}/tasks/:id/snooze`, ({ params }) =>
      HttpResponse.json(TASKS.find((t) => t.id === params.id))
    ),
    http.post(`${API}/tasks/:id/claim`, ({ params }) =>
      HttpResponse.json({ ...TASKS.find((t) => t.id === params.id), assignedTo: ME })
    )
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
const completes = () => writes.filter((w) => w.what.endsWith('/complete'));

describe('the Done (Water) button on a Plants row', () => {
  it('writes nothing until the Undo window has passed, then exactly one completion', async () => {
    const u = user();
    renderPlants();
    const water = await screen.findByRole('button', { name: 'Water Peace Lily' });
    await u.click(water);

    // The window: the row says it is done and the button became Undo.
    expect(screen.getByRole('button', { name: 'Undo: Water Peace Lily' })).toBeInTheDocument();
    expect(screen.getByText('Done: Water, Peace Lily')).toBeInTheDocument();
    await pass(UNDO_WINDOW_MS - 100);
    expect(writes).toEqual([]);

    await pass(200);
    expect(completes()).toHaveLength(1);
    expect(completes()[0].what).toBe('POST /tasks/t1/complete');
    expect(completes()[0].body).toEqual({ expectedNextDue: TASKS[0].nextDue });
    await pass(UNDO_WINDOW_MS * 3);
    expect(completes()).toHaveLength(1);
  });

  it('an undone water writes NOTHING to the API (the row button)', async () => {
    const u = user();
    renderPlants();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    await pass(1000);
    await u.click(screen.getByRole('button', { name: 'Undo: Water Peace Lily' }));
    await pass(UNDO_WINDOW_MS * 3);
    expect(writes).toEqual([]);
    expect(screen.getByRole('button', { name: 'Water Peace Lily' })).toBeInTheDocument();
  });

  it('an undone water writes NOTHING to the API (the toast Undo)', async () => {
    const u = user();
    renderPlants();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    const toastUndo = await screen.findByRole('button', { name: 'Undo' });
    await u.click(toastUndo);
    await pass(UNDO_WINDOW_MS * 3);
    expect(writes).toEqual([]);
  });

  it('a double tap is one completion, not two', async () => {
    const u = user();
    renderPlants();
    const water = await screen.findByRole('button', { name: 'Water Peace Lily' });
    await u.dblClick(water);
    await pass(UNDO_WINDOW_MS * 2);
    // The second tap was the Undo button: nothing. Tap, wait, tap again: one.
    expect(completes()).toHaveLength(0);
    await u.click(screen.getByRole('button', { name: 'Water Peace Lily' }));
    await u.click(screen.getByRole('button', { name: 'Undo: Water Peace Lily' }));
    await u.click(screen.getByRole('button', { name: 'Water Peace Lily' }));
    await pass(UNDO_WINDOW_MS + 100);
    expect(completes()).toHaveLength(1);
  });

  it('survives leaving the page: still exactly one completion when the window ends', async () => {
    const u = user();
    renderPlants();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    await u.click(screen.getByRole('button', { name: 'leave' }));
    expect(await screen.findByText('Tasks page')).toBeInTheDocument();
    expect(writes).toEqual([]);
    await pass(UNDO_WINDOW_MS + 100);
    expect(completes()).toHaveLength(1);
  });

  it('commits at once when the app goes to the background, and never again', async () => {
    const u = user();
    renderPlants();
    await u.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    visibility.mockRestore();
    await pass(10);
    expect(completes()).toHaveLength(1);
    await pass(UNDO_WINDOW_MS * 2);
    expect(completes()).toHaveLength(1);
  });

  it('shows the plant’s house rule first; cancelling it writes nothing', async () => {
    const u = user();
    renderPlants();
    await u.click(await screen.findByRole('button', { name: 'Water Monstera' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Bottom-water this one.')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await pass(UNDO_WINDOW_MS * 2);
    expect(writes).toEqual([]);

    await u.click(screen.getByRole('button', { name: 'Water Monstera' }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /mark done/i })
    );
    await pass(UNDO_WINDOW_MS + 100);
    expect(completes().map((w) => w.what)).toEqual(['POST /tasks/t2/complete']);
  });

  it('only work that is due has the button', async () => {
    renderPlants();
    await screen.findByRole('button', { name: 'Water Peace Lily' });
    expect(screen.queryByRole('button', { name: 'Water Snake Plant' })).not.toBeInTheDocument();
  });
});

/** jsdom drops `pointerType` and the coordinates from a synthetic pointer
 *  event's init, so set them on the event itself. */
function touch(kind: 'pointerDown' | 'pointerMove' | 'pointerUp', el: Element, x = 50) {
  const event = createEvent[kind](el);
  for (const [key, value] of Object.entries({
    pointerType: 'touch',
    pointerId: 1,
    clientX: x,
    clientY: 50,
  }))
    Object.defineProperty(event, key, { value });
  fireEvent(el, event);
}

describe('the row menu (long press, right click)', () => {
  const openMenu = async (name: RegExp) => {
    const link = await screen.findByRole('link', { name });
    fireEvent.contextMenu(link);
    return screen.findByRole('dialog');
  };

  it('after a long press that brought no click, the next keyboard press still works', async () => {
    const u = user();
    renderPlants();
    const row = (await screen.findByRole('link', { name: /^Peace Lily/ })).parentElement!;
    touch('pointerDown', row);
    await pass(600); // the long press opens the menu
    touch('pointerUp', row); // iOS: no click follows a long press
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' })
    );
    await pass(500);
    // Enter on the Water button: a click with no pointer down before it.
    screen.getByRole('button', { name: 'Water Peace Lily' }).focus();
    await u.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Undo: Water Peace Lily' })).toBeInTheDocument();
  });

  it('Water now goes through the same Undo window', async () => {
    const u = user();
    renderPlants();
    const sheet = await openMenu(/^Peace Lily/);
    await u.click(within(sheet).getByRole('button', { name: 'Water now' }));
    expect(writes).toEqual([]);
    await pass(UNDO_WINDOW_MS + 100);
    expect(completes()).toHaveLength(1);
  });

  it('Cancel writes nothing', async () => {
    const u = user();
    renderPlants();
    const sheet = await openMenu(/^Peace Lily/);
    await u.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await pass(UNDO_WINDOW_MS * 2);
    expect(writes).toEqual([]);
  });

  it('Snooze asks how long, and only a choice snoozes', async () => {
    const u = user();
    renderPlants();
    let sheet = await openMenu(/^Peace Lily/);
    await u.click(within(sheet).getByRole('button', { name: 'Snooze…' }));
    sheet = await screen.findByRole('dialog', { name: 'Snooze' });
    await u.click(within(sheet).getByRole('button', { name: '3 days' }));
    await pass(50);
    expect(writes).toEqual([
      {
        what: 'POST /tasks/t1/snooze',
        body: { days: 3, expectedNextDue: TASKS[0].nextDue },
      },
    ]);
  });

  it('I’ll do it claims an open task', async () => {
    const u = user();
    renderPlants();
    const sheet = await openMenu(/^Peace Lily/);
    await u.click(within(sheet).getByRole('button', { name: 'I’ll do it' }));
    await pass(50);
    expect(writes.map((w) => w.what)).toEqual(['POST /tasks/t1/claim']);
  });
});

describe('swiping a Plants row', () => {
  const swipe = async (name: RegExp, from: number, to: number) => {
    const row = (await screen.findByRole('link', { name })).parentElement!;
    touch('pointerDown', row, from);
    touch('pointerMove', row, from + Math.sign(to - from) * 40);
    touch('pointerMove', row, to);
    touch('pointerUp', row, to);
    return row;
  };

  it('all the way right is Water, through the same Undo window', async () => {
    renderPlants();
    await swipe(/^Peace Lily/, 20, 340);
    expect(screen.getByRole('button', { name: 'Undo: Water Peace Lily' })).toBeInTheDocument();
    expect(writes).toEqual([]);
    await pass(UNDO_WINDOW_MS + 100);
    expect(completes()).toHaveLength(1);
  });

  it('left reveals Snooze and More; a tap on the open row closes it, not opening the plant', async () => {
    const u = user();
    renderPlants();
    const row = await swipe(/^Peace Lily/, 300, 100);
    expect(row.style.transform).toBe('translateX(-176px)');
    const li = row.closest('li')!;
    expect(
      within(li)
        .getAllByRole('button')
        .filter((b) => b.closest('[aria-hidden="false"]'))
        .map((b) => b.getAttribute('aria-label'))
    ).toEqual(['Snooze', 'More']);
    await u.click(within(row).getByRole('link'));
    expect(row.style.transform).toBe('');
    expect(screen.queryByText('Plant page')).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('only one row is open at a time, on Plants too', async () => {
    renderPlants();
    const lily = await swipe(/^Peace Lily/, 300, 100);
    expect(lily.style.transform).toBe('translateX(-176px)');
    const monstera = await swipe(/^Monstera/, 300, 100);
    await vi.waitFor(() => expect(lily.style.transform).toBe(''));
    expect(monstera.style.transform).toBe('translateX(-176px)');
  });

  it('a row with nothing due does not swipe right', async () => {
    renderPlants();
    const row = await swipe(/^Snake Plant/, 20, 340);
    expect(row.style.transform).toBe('');
    expect(writes).toEqual([]);
  });
});
