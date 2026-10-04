import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '@/features/tasks/TasksPage';
import { Toaster } from '@/components/Toaster';
import { UNDO_WINDOW_MS, resetDeferredCareQueueForTests } from '@/features/plants/deferredCare';
import { useAuthStore, type User } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import i18n from '@/i18n';
import { ensureLocaleCatalog } from '@/i18n/nonEnglishCatalog';
import { server } from '../../../msw/server';

/**
 * The Tasks tab on a phone ("Checklist"): a Today / Upcoming segment, rows
 * with the check circle on the left, and who has each task as You, an
 * initial, or a raised hand. The desktop website keeps its own layout.
 */
const API = 'http://localhost:4000';
let writes: string[] = [];

function due(daysFromNow: number, hour = 12): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

type Seed = {
  id: string;
  plant: string;
  days: number;
  hour?: number;
  who?: 'me' | 'theo' | null;
  type?: string;
};

const SEED: Seed[] = [
  // Stored times are scrambled on purpose: the list must sort by name.
  { id: 't-fern', plant: 'Boston Fern', days: -3, who: 'me' },
  { id: 't-bird', plant: 'Bird of Paradise', days: -2, who: null },
  { id: 't-rubber', plant: 'Rubber Plant', days: 0, hour: 1, who: 'theo' },
  { id: 't-aloe', plant: 'Aloe', days: 0, hour: 23, who: null },
  { id: 't-pothos', plant: 'Golden Pothos', days: 0, hour: 9, who: 'me' },
  { id: 't-lemon', plant: 'Lemon Tree', days: 1, who: 'me' },
  { id: 't-hoya', plant: 'Hoya', days: 4, who: 'theo' },
];

const ROOM: Record<string, string> = {
  'Boston Fern': 'kitchen',
  'Bird of Paradise': 'living',
  'Rubber Plant': 'living',
  Aloe: 'kitchen',
  'Golden Pothos': 'kitchen',
  'Lemon Tree': 'porch',
  Hoya: 'living',
};

function apiTask(s: Seed) {
  const assignee = s.who === 'me' ? 'u1' : s.who === 'theo' ? 'u2' : null;
  return {
    id: s.id,
    plantId: `p-${s.id}`,
    plantName: s.plant,
    type: s.type ?? 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: due(s.days, s.hour),
    assignedTo: assignee,
    assignedToName: s.who === 'me' ? 'Marisol Reyes' : s.who === 'theo' ? 'Theo Nakamura' : null,
    assignmentSource: assignee ? null : null,
    notes: null,
    createdBy: 'u1',
    createdAt: '',
  };
}

function serve(seed: Seed[] = SEED) {
  server.use(
    http.get(`${API}/tasks`, () => HttpResponse.json(seed.map(apiTask))),
    http.get(`${API}/plants`, () =>
      HttpResponse.json(
        seed.map((s) => ({
          id: `p-${s.id}`,
          householdId: 'hh-1',
          name: s.plant,
          species: null,
          location: null,
          spaceId: ROOM[s.plant],
          imageUrl: null,
          notes: null,
          careRule: null,
          createdAt: '',
          createdBy: 'u1',
          updatedAt: '',
        }))
      )
    ),
    http.get(`${API}/spaces`, () =>
      HttpResponse.json([
        { id: 'living', householdId: 'hh-1', name: 'Living Room', environment: 'inside' },
        { id: 'kitchen', householdId: 'hh-1', name: 'Kitchen', environment: 'inside' },
        { id: 'porch', householdId: 'hh-1', name: 'Back Porch', environment: 'outside' },
      ])
    ),
    http.get(`${API}/households/hh-1/climate`, () => HttpResponse.json({ status: 'no_location' })),
    http.post(`${API}/tasks/:id/complete`, () => HttpResponse.json(apiTask(SEED[0]))),
    http.post(`${API}/tasks/:id/claim`, () => HttpResponse.json(apiTask(SEED[1])))
  );
}

function phone(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: on && query === '(max-width: 639px)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderTasks(path = '/tasks') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TasksPage />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** jsdom drops `pointerType` and the coordinates from a synthetic pointer
 *  event's init, so set them on the event itself. */
function touch(kind: 'pointerDown' | 'pointerUp', el: Element) {
  const event = createEvent[kind](el);
  for (const [key, value] of Object.entries({
    pointerType: 'touch',
    pointerId: 1,
    clientX: 50,
    clientY: 50,
  }))
    Object.defineProperty(event, key, { value });
  fireEvent(el, event);
}

/** The web action sheet (Headless UI), and its title. */
async function sheetFor(title: string) {
  const sheet = await screen.findByRole('dialog');
  expect(sheet).toHaveTextContent(new RegExp(`^${title}`));
  return sheet;
}

const rowNames = (section: string) =>
  within(screen.getByRole('region', { name: section }))
    .getAllByRole('link')
    .map((link) => link.getAttribute('aria-label')!.split(',')[0]);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetDeferredCareQueueForTests();
  useToastStore.setState({ toasts: [] });
  writes = [];
  useAuthStore.setState({
    accessToken: 'access-1',
    user: { id: 'u1', email: 'me@example.com', name: 'Marisol Reyes', householdId: 'hh-1' } as User,
  });
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' && !path.startsWith('/telemetry')) {
      writes.push(`${request.method} ${path}`);
    }
  });
  phone(true);
  serve();
});

afterEach(async () => {
  await i18n.changeLanguage('en');
  server.events.removeAllListeners();
  vi.useRealTimers();
  phone(false);
});

describe('Tasks on a phone ("Checklist")', () => {
  it('opens on Today: overdue first, then today, same-day tasks by plant name', async () => {
    renderTasks();
    await screen.findByRole('region', { name: 'Overdue' });
    expect(rowNames('Overdue')).toEqual(['Boston Fern', 'Bird of Paradise']);
    // Stored at 23:00, 09:00 and 01:00: the list still reads alphabetically.
    expect(rowNames('Today')).toEqual(['Aloe', 'Golden Pothos', 'Rubber Plant']);
    // Tomorrow's work is on the other segment, not under Today.
    expect(screen.queryByRole('link', { name: /^Lemon Tree/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Today 5$/, pressed: true })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Upcoming 2$/, pressed: false })
    ).toBeInTheDocument();
    // None of the desktop controls.
    expect(screen.queryByRole('group', { name: 'Task filters' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Care round' })).toBeNull();
  });

  it('says who has each task: You, an initial, or a raised hand, never "Assigned to"', async () => {
    renderTasks();
    const fern = await screen.findByRole('link', { name: /^Boston Fern/ });
    expect(fern).toHaveAccessibleName('Boston Fern, Water · 3 days overdue, Kitchen, You');
    expect(within(fern.parentElement!).getByTestId('task-row-who')).toHaveTextContent('You');
    const rubber = screen.getByRole('link', { name: /^Rubber Plant/ });
    expect(rubber).toHaveAccessibleName('Rubber Plant, Water, Living Room, Theo Nakamura');
    expect(within(rubber.parentElement!).getByTestId('task-row-who')).toHaveTextContent(/^T$/);
    const aloe = screen.getByRole('link', { name: /^Aloe/ });
    expect(aloe).toHaveAccessibleName(/Up for grabs$/);
    expect(screen.queryByText(/Assigned to/)).toBeNull();
  });

  it('Upcoming lists tomorrow and later, one heading per day', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    await user.click(await screen.findByRole('button', { name: /^Upcoming/ }));
    expect(rowNames('Tomorrow')).toEqual(['Lemon Tree']);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent!);
    expect(headings).toHaveLength(2);
    // The later day is named, starting with a capital (es: "Jueves, …").
    expect(headings[1]).toMatch(/^\p{Lu}/u);
    expect(screen.queryByRole('region', { name: 'Overdue' })).toBeNull();
  });

  it('in Spanish, the segments, headings and rows are Spanish, and a day heading is capitalized', async () => {
    // Load the shipped Spanish catalog the way the language picker does.
    await ensureLocaleCatalog(i18n, 'es');
    await i18n.changeLanguage('es');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    expect(await screen.findByRole('heading', { level: 2, name: 'Atrasadas' })).toBeVisible();
    expect(screen.getByRole('link', { name: /^Boston Fern/ })).toHaveAccessibleName(
      'Boston Fern, Regar: 3 días de retraso, Kitchen, Tú'
    );
    await user.click(screen.getByRole('button', { name: /^Próximas/ }));
    const later = screen.getAllByRole('heading', { level: 2 })[1].textContent!;
    expect(later).not.toBe('Mañana');
    expect(later.charAt(0)).toBe(later.charAt(0).toLocaleUpperCase('es'));
    expect(later.charAt(0)).not.toBe(later.charAt(0).toLocaleLowerCase('es'));
  });

  it('the check circle starts the 5-second Undo, and writes only after it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    const check = await screen.findByRole('button', { name: 'Water Golden Pothos' });
    await user.click(check);
    expect(screen.getByRole('button', { name: 'Undo: Water Golden Pothos' })).toBeInTheDocument();
    expect(writes).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 50);
    });
    expect(writes).toEqual(['POST /tasks/t-pothos/complete']);
  });

  it('Undo inside the window writes nothing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    await user.click(await screen.findByRole('button', { name: 'Water Golden Pothos' }));
    await user.click(screen.getByRole('button', { name: 'Undo: Water Golden Pothos' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 50);
    });
    expect(writes).toEqual([]);
    expect(screen.getByRole('button', { name: 'Water Golden Pothos' })).toBeInTheDocument();
  });

  it('the filter menu shows only mine, and its token clears it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    await screen.findByRole('region', { name: 'Overdue' });
    await user.click(screen.getByLabelText('Filter tasks'));
    await user.click(screen.getByRole('button', { name: 'Only mine' }));
    expect(rowNames('Overdue')).toEqual(['Boston Fern']);
    expect(rowNames('Today')).toEqual(['Golden Pothos']);
    await user.click(screen.getByRole('button', { name: 'Remove filter: Only mine' }));
    expect(rowNames('Today')).toEqual(['Aloe', 'Golden Pothos', 'Rubber Plant']);
  });

  it('grouped by space, Today lists only what is due, never later work', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    await screen.findByRole('region', { name: 'Overdue' });
    await user.click(screen.getByLabelText('Filter tasks'));
    await user.click(screen.getByRole('button', { name: 'Space' }));
    expect(rowNames('Kitchen')).toEqual(['Boston Fern', 'Aloe', 'Golden Pothos']);
    // Hoya (Living Room) is due in 4 days: not part of today's round.
    expect(rowNames('Living Room')).toEqual(['Bird of Paradise', 'Rubber Plant']);
    expect(screen.queryByRole('region', { name: 'Back Porch' })).toBeNull();
  });

  it('the row actions: a long press and the Actions button open them, and Claim claims', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    const bird = await screen.findByRole('link', { name: /^Bird of Paradise/ });
    // A long press on the row (touch).
    const row = bird.parentElement!;
    touch('pointerDown', row);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    touch('pointerUp', row);
    const sheet = await sheetFor('Bird of Paradise');
    expect(
      within(sheet)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Water now', 'I’ll do it', 'Ask family…', 'Open plant', 'Cancel']);
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(writes).toEqual([]);

    // The same menu without a gesture, from the button keyboard and
    // VoiceOver users reach.
    await user.click(screen.getByRole('button', { name: 'Actions for Bird of Paradise' }));
    await user.click(
      within(await sheetFor('Bird of Paradise')).getByRole('button', {
        name: 'I’ll do it',
      })
    );
    await vi.waitFor(() => expect(writes).toEqual(['POST /tasks/t-bird/claim']));
  });

  it('after a long press that brought no click, the next keyboard press still works', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    const link = await screen.findByRole('link', { name: /^Golden Pothos/ });
    const row = link.parentElement!;
    touch('pointerDown', row);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    touch('pointerUp', row); // iOS: no click follows a long press
    await user.click(
      within(await sheetFor('Golden Pothos')).getByRole('button', { name: 'Cancel' })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Enter on the check circle: a click with no pointer down before it.
    screen.getByRole('button', { name: 'Water Golden Pothos' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Undo: Water Golden Pothos' })).toBeInTheDocument();
  });

  it('your own task offers Unclaim, and a household with no tasks gets one next step', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTasks();
    await user.click(await screen.findByRole('button', { name: 'Actions for Boston Fern' }));
    const sheet = await sheetFor('Boston Fern');
    expect(within(sheet).getByRole('button', { name: 'Unclaim' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'I’ll do it' })).toBeNull();
  });

  it('a household with no tasks: one sentence and Add plant, no segments', async () => {
    serve([]);
    renderTasks();
    expect(await screen.findByRole('heading', { name: 'No care scheduled yet' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add plant' })).toHaveAttribute('href', '/plants/new');
    expect(screen.queryByRole('group', { name: 'Show tasks for' })).toBeNull();
  });

  it('nothing left today: says so and names what is next', async () => {
    serve(SEED.filter((s) => s.days > 0));
    renderTasks();
    expect(await screen.findByRole('heading', { name: 'All done for today' })).toBeVisible();
    expect(screen.getByText('Next up: Lemon Tree, tomorrow.')).toBeVisible();
  });

  it('the desktop website keeps its own layout', async () => {
    phone(false);
    renderTasks();
    expect(await screen.findByRole('group', { name: 'Task filters' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Show tasks for' })).toBeNull();
  });
});
