import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '@/features/tasks/TasksPage';
import type { NativeBarTools } from '@/config/nativeBarTools';
import { useAuthStore, type User } from '@/store/authStore';
import { server } from '../../../msw/server';

/**
 * In the iOS app, the Tasks list hands its filter menu to the native
 * navigation bar (NativeChrome `setBarTools`) and drops the web one. The
 * plugin is replaced by a fake that records what was sent and lets a test
 * play the person picking a menu item.
 */
const native = vi.hoisted(() => ({
  sent: [] as unknown[],
  listeners: {} as Record<string, Array<(event: unknown) => void>>,
}));

vi.mock('@/services/loadNativeChrome', () => {
  const fake: Record<string, unknown> = {
    setBarTools: (tools: unknown) => {
      native.sent.push(tools);
      return Promise.resolve();
    },
    addListener: (name: string, listener: (event: unknown) => void) => {
      (native.listeners[name] ??= []).push(listener);
      return Promise.resolve({
        remove: () => {
          native.listeners[name] = (native.listeners[name] ?? []).filter((l) => l !== listener);
          return Promise.resolve();
        },
      });
    },
  };
  // Like Capacitor's plugin proxy: every other property, `then` included, is
  // a native method the app does not have. A promise resolved with the plugin
  // itself calls its `then` and fails, which is what the app did once.
  const NativeChrome = new Proxy(fake, {
    get: (target, prop) =>
      prop in target
        ? target[prop as string]
        : () => {
            throw new Error(`"NativeChrome.${String(prop)}()" is not implemented on ios`);
          },
  });
  return { loadNativeChrome: async () => ({ NativeChrome }) };
});

const API = 'http://localhost:4000';

function due(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}
const T = (id: string, plant: string, days: number, assignedTo: string | null) => ({
  id,
  plantId: `p-${id}`,
  plantName: plant,
  type: 'water',
  customType: null,
  frequency: 7,
  lastCompleted: null,
  nextDue: due(days),
  assignedTo,
  assignedToName: assignedTo === 'u1' ? 'Marisol Reyes' : assignedTo ? 'Theo Nakamura' : null,
  assignmentSource: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
});
const TASKS = [
  T('a', 'Aloe', 0, null),
  T('b', 'Basil', 0, 'u1'),
  T('c', 'Calathea', -1, 'u2'),
  T('d', 'Dill', 0, null),
];
const ROOM: Record<string, string> = { Aloe: 'k', Basil: 'k', Calathea: 'b', Dill: 'b' };

function pretendToBeTheIosApp(methods: string[]) {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    PluginHeaders: [{ name: 'NativeChrome', methods: methods.map((name) => ({ name })) }],
  };
}

function renderTasks(path = '/tasks') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const rowNames = () =>
  screen
    .getAllByRole('link')
    .map((l) => l.getAttribute('aria-label') ?? '')
    .filter(Boolean)
    .map((label) => label.split(',')[0]);

function lastSent(): NativeBarTools {
  return native.sent[native.sent.length - 1] as NativeBarTools;
}

async function fire(name: string, event: unknown) {
  await waitFor(() => expect(native.listeners[name]?.length).toBeGreaterThan(0));
  await act(async () => {
    for (const listener of native.listeners[name]) listener(event);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.mocked(window.scrollTo).mockClear();
  native.sent.length = 0;
  for (const key of Object.keys(native.listeners)) delete native.listeners[key];
  useAuthStore.setState({
    accessToken: 'a',
    user: { id: 'u1', name: 'Marisol Reyes', householdId: 'hh-1' } as User,
  });
  server.use(
    http.get(`${API}/tasks`, () => HttpResponse.json(TASKS)),
    http.get(`${API}/plants`, () =>
      HttpResponse.json(
        TASKS.map((t) => ({
          id: t.plantId,
          householdId: 'hh-1',
          name: t.plantName,
          spaceId: ROOM[t.plantName],
          species: null,
          location: null,
          imageUrl: null,
          notes: null,
          createdAt: '',
          createdBy: '',
          updatedAt: '',
        }))
      )
    ),
    http.get(`${API}/spaces`, () =>
      HttpResponse.json([
        { id: 'k', householdId: 'hh-1', name: 'Kitchen', environment: 'inside' },
        { id: 'b', householdId: 'hh-1', name: 'Bedroom', environment: 'inside' },
      ])
    ),
    http.get(`${API}/households/hh-1/climate`, () => HttpResponse.json({ status: 'no_location' }))
  );
  pretendToBeTheIosApp(['configure', 'update', 'present', 'setBarTools']);
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('Tasks in the iOS app with bar tools', () => {
  it('sends the filter menu to the bar under the screen path, and drops the web menu', async () => {
    renderTasks();
    await screen.findByRole('heading', { level: 2, name: 'Overdue' }, { timeout: 10000 });
    await waitFor(() => expect(lastSent()?.menus[0]?.groups).toHaveLength(3));
    const tools = lastSent();
    expect(tools.path).toBe('/tasks');
    expect(tools.search).toBeNull();
    expect(tools.menus.map((m) => [m.id, m.label, m.symbol])).toEqual([
      ['filter', 'Filter tasks', 'line.3.horizontal.decrease.circle'],
    ]);
    expect(tools.menus[0].groups.map((g) => g.items.map((i) => i.id))).toEqual([
      ['who:all', 'who:mine', 'who:open'],
      ['group:date', 'group:room'],
      ['space:', 'space:k', 'space:b', 'space:unplaced'],
    ]);
    expect(screen.queryByLabelText('Filter tasks')).not.toBeInTheDocument();
  });

  it('Up for grabs from the bar shows only unclaimed work, with a token to clear it', async () => {
    renderTasks();
    await screen.findByRole('heading', { level: 2, name: 'Overdue' }, { timeout: 10000 });
    await fire('barMenuSelect', { path: '/tasks', id: 'who:open' });
    await waitFor(() => expect(rowNames()).toEqual(['Aloe', 'Dill']));
    expect(screen.getByRole('button', { name: 'Remove filter: Up for grabs' })).toBeVisible();
    // The bar scrolls to the top itself; the page must not undo that.
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(lastSent().menus[0].groups[0].items.find((i) => i.id === 'who:open')?.checked).toBe(
      true
    );
  });

  it('a space from the bar narrows the list, named by a token, not by a URL change', async () => {
    renderTasks();
    await screen.findByRole('heading', { level: 2, name: 'Overdue' }, { timeout: 10000 });
    await fire('barMenuSelect', { path: '/tasks', id: 'space:b' });
    await waitFor(() => expect(rowNames()).toEqual(['Calathea', 'Dill']));
    expect(screen.getByRole('button', { name: 'Remove filter: Bedroom' })).toBeVisible();
    // Still filed under "/tasks": the screen did not change.
    expect(lastSent().path).toBe('/tasks');
  });

  it('a deep link with a query files the tools under that path and still answers picks', async () => {
    renderTasks('/tasks?filter=mine');
    await screen.findByRole('button', { name: 'Remove filter: Only mine' }, { timeout: 10000 });
    expect(rowNames()).toEqual(['Basil']);
    await waitFor(() => expect(lastSent()?.path).toBe('/tasks?filter=mine'));
    await fire('barMenuSelect', { path: '/tasks?filter=mine', id: 'who:all' });
    await waitFor(() => expect(rowNames()).toEqual(['Calathea', 'Aloe', 'Basil', 'Dill']));
  });

  it('grouped by space from the bar: the room with the most overdue task first', async () => {
    renderTasks();
    await screen.findByRole('heading', { level: 2, name: 'Overdue' }, { timeout: 10000 });
    await fire('barMenuSelect', { path: '/tasks', id: 'group:room' });
    const headings = await screen.findAllByRole('heading', { level: 2 });
    // Bedroom holds the overdue Calathea, so it leads, though Kitchen comes
    // first in the household's own order.
    expect(headings.map((h) => h.textContent)).toEqual(['Bedroom', 'Kitchen']);
    expect(
      within(screen.getByRole('region', { name: 'Bedroom' }))
        .getAllByRole('link')
        .map((l) => l.getAttribute('aria-label')!.split(',')[0])
    ).toEqual(['Calathea', 'Dill']);
  });
});
