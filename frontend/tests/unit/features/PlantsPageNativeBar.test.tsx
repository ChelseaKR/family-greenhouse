import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantsPage } from '@/features/plants/PlantsPage';
import type { NativeBarTools } from '@/config/nativeBarTools';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * In the iOS app, the Plants list hands its search field and both menus to
 * the native navigation bar (NativeChrome `setBarTools`) and drops its own
 * row of controls. The plugin is replaced by a fake that records what was
 * sent and lets a test play the person picking a menu item or typing.
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
const ME = 'u-me';

function plant(id: string, name: string) {
  return {
    id,
    householdId: 'hh-1',
    name,
    species: null,
    location: null,
    imageUrl: null,
    notes: null,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
  };
}
function task(id: string, plantId: string, assignedTo: string | null) {
  const due = new Date();
  due.setHours(23, 0, 0, 0);
  return {
    id,
    plantId,
    plantName: plantId,
    type: 'water',
    frequency: 7,
    lastCompleted: null,
    nextDue: due.toISOString(),
    assignedTo,
    assignedToName: assignedTo ? 'Someone' : null,
    notes: null,
    createdBy: 'x',
    createdAt: '',
  };
}

function pretendToBeTheIosApp(methods: string[]) {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    PluginHeaders: [{ name: 'NativeChrome', methods: methods.map((name) => ({ name })) }],
  };
}

function renderPlants() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants']}>
        <Routes>
          <Route path="/plants" element={<PlantsPage />} />
          <Route path="/plants/import" element={<div>Import Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** The plant rows (the hidden web "Add plant" link is not one). */
const rows = () =>
  screen.getAllByRole('link').filter((l) => /^\/plants\/p\d$/.test(l.getAttribute('href') ?? ''));

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
  useAuthStore.setState({ accessToken: 'a', user: { id: ME, householdId: 'hh-1' } as never });
  server.use(
    http.get(`${API}/plants`, () =>
      HttpResponse.json([plant('p1', 'Peace Lily'), plant('p2', 'Basil'), plant('p3', 'Aloe')])
    ),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/tasks`, () =>
      HttpResponse.json([task('t1', 'p1', null), task('t2', 'p2', ME), task('t3', 'p3', 'u-x')])
    )
  );
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

const ALL = ['configure', 'update', 'present', 'updatePresented', 'dismissPresented'];

describe('Plants in the iOS app with bar tools', () => {
  beforeEach(() => pretendToBeTheIosApp([...ALL, 'setBarTools']));

  it('sends the Filter and More menus and the search field to the bar, and drops the web row', async () => {
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' }, { timeout: 10000 });
    await waitFor(() => expect(native.sent.length).toBeGreaterThan(0), { timeout: 10000 });

    const tools = lastSent();
    expect(tools.path).toBe('/plants');
    expect(tools.menus.map((m) => [m.id, m.label, m.symbol])).toEqual([
      ['filter', 'Filter plants', 'line.3.horizontal.decrease.circle'],
      ['more', 'More plant actions', 'ellipsis.circle'],
    ]);
    expect(tools.search).toEqual({ placeholder: 'Search plants', text: '' });
    const groupBy = tools.menus[0].groups[0];
    expect(groupBy.items.map((i) => [i.id, i.checked])).toEqual([
      ['group:care', true],
      ['group:room', false],
      ['group:name', false],
    ]);

    expect(screen.queryByLabelText('Search plants')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Filter plants')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('More plant actions')).not.toBeInTheDocument();
  });

  it('a pick in the native menu filters the list and the bar shows the new check', async () => {
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' }, { timeout: 10000 });
    await fire('barMenuSelect', { path: '/plants', id: 'who:mine' });

    await waitFor(() =>
      expect(rows().map((l) => l.textContent)).toEqual([expect.stringContaining('Basil')])
    );
    expect(screen.getByRole('button', { name: 'Remove filter: Only mine' })).toBeInTheDocument();
    // The native bar scrolls to the top itself; the page must not, or it
    // would undo that (WKWebView's top at rest sits above zero).
    expect(window.scrollTo).not.toHaveBeenCalled();
    const show = lastSent().menus[0].groups[1];
    expect(show.items.find((i) => i.id === 'who:mine')?.checked).toBe(true);
  });

  it('typing in the bar search filters and announces the count', async () => {
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' }, { timeout: 10000 });
    await fire('barSearch', { path: '/plants', text: 'lily' });

    expect(await screen.findByText(/1 plant matches “lily”/)).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
    expect(lastSent().search).toEqual({ placeholder: 'Search plants', text: 'lily' });
  });

  it('ignores a pick meant for another screen', async () => {
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' }, { timeout: 10000 });
    await fire('barMenuSelect', { path: '/tasks', id: 'who:mine' });
    expect(rows()).toHaveLength(3);
  });

  it('opens the More actions from the native menu', async () => {
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' }, { timeout: 10000 });
    await fire('barMenuSelect', { path: '/plants', id: 'act:import' });
    expect(await screen.findByText('Import Page')).toBeInTheDocument();
  });

  it('an empty household sends no menus and no search', async () => {
    server.use(http.get(`${API}/plants`, () => HttpResponse.json([])));
    renderPlants();
    await screen.findByText(/let's add your first plant/i);
    await waitFor(() => expect(lastSent()).toEqual({ path: '/plants', menus: [], search: null }));
  });
});

describe('Plants in an iOS app built before bar tools', () => {
  beforeEach(() => pretendToBeTheIosApp(ALL));

  it('keeps the web search and menus, and sends nothing', async () => {
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' }, { timeout: 10000 });
    expect(screen.getByLabelText('Search plants')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter plants')).toBeInTheDocument();
    expect(native.sent).toEqual([]);
  });
});
