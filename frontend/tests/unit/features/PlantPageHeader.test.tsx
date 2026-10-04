import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import type { NativeBarTools } from '@/config/nativeBarTools';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * The top of the plant page on a phone: the header, the status card with
 * the thing to do now (Watered / I'll do it / Snooze), and every other
 * action in a "…" menu, in the navigation bar in the iOS app. Every request
 * that is not a GET is recorded.
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
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
  };
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
let writes: string[] = [];

function dueIn(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 0, 0, 0);
  return d.toISOString();
}

function plantBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Peace Lily',
    species: 'Spathiphyllum wallisii',
    location: 'Bedroom',
    imageUrl: null,
    notes: 'Droops before it needs water.',
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
        lastCompleted: dueIn(-8),
        nextDue: dueIn(-1),
        assignedTo: null,
        assignedToName: null,
        notes: null,
        createdBy: 'u1',
        createdAt: '',
      },
    ],
    recentCompletions: [
      {
        id: 'c1',
        taskId: 't1',
        taskType: 'water',
        completedBy: 'u-dana',
        completedByName: 'Dana',
        completedAt: dueIn(-8),
        notes: null,
      },
    ],
    ...overrides,
  };
}

function renderPlant() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants/p1']}>
        <Routes>
          <Route path="/plants/:plantId" element={<PlantDetailPage />} />
          <Route path="/plants/:plantId/passport" element={<p>Passport page</p>} />
          <Route path="/plants/new" element={<p>Add plant page</p>} />
        </Routes>
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
  writes = [];
  native.sent.length = 0;
  for (const key of Object.keys(native.listeners)) delete native.listeners[key];
  useAuthStore.setState({ accessToken: 'a', user: { id: 'u-me', householdId: 'hh-1' } as never });
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' && !path.startsWith('/telemetry')) {
      writes.push(`${request.method} ${path}`);
    }
  });
  server.use(
    http.get(`${API}/plants/p1`, () => HttpResponse.json(plantBody())),
    http.post(`${API}/tasks/t1/complete`, () => HttpResponse.json({})),
    http.post(`${API}/tasks/t1/claim`, () => HttpResponse.json({})),
    http.post(`${API}/tasks/t1/snooze`, () => HttpResponse.json({}))
  );
});
afterEach(() => {
  server.events.removeAllListeners();
  window.matchMedia = realMatchMedia;
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('the plant page on a phone', () => {
  beforeEach(() => {
    window.matchMedia = phone(true);
  });

  it('leads with what the plant needs now and who has it, not a grid of buttons', async () => {
    renderPlant();
    const card = await screen.findByRole('region', { name: 'What this plant needs now' });
    expect(within(card).getByText('Water · 1 day overdue')).toBeInTheDocument();
    expect(within(card).getByText(/^Up for grabs · last by Dana, /)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Water Peace Lily' })).toHaveTextContent(
      'Watered'
    );
    expect(within(card).getByRole('button', { name: 'I’ll do it' })).toBeInTheDocument();
    expect(within(card).getByLabelText('Snooze task')).toBeInTheDocument();

    // The nine actions are in the closed "…" menu, not on the page.
    for (const name of [/take photo/i, /propagate/i, /^share cutting$/i, /^edit$/i, /^remove$/i]) {
      for (const button of screen.queryAllByRole('button', { name })) {
        expect(button.closest('details')).not.toBeNull();
      }
    }
    const menu = screen.getByLabelText('More plant actions').closest('details')!;
    const labels = within(menu)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual([
      'Take photo',
      'Choose photo',
      'Check leaf health',
      'Move',
      'Propagate cutting',
      'Share cutting',
      'Passport',
      'Edit',
      'Remove…',
    ]);
  });

  it('Watered completes this occurrence', async () => {
    const user = userEvent.setup();
    renderPlant();
    await user.click(await screen.findByRole('button', { name: 'Water Peace Lily' }));
    await waitFor(() => expect(writes).toEqual(['POST /tasks/t1/complete']));
  });

  it('I’ll do it claims an open task', async () => {
    const user = userEvent.setup();
    renderPlant();
    await user.click(await screen.findByRole('button', { name: 'I’ll do it' }));
    await waitFor(() => expect(writes).toEqual(['POST /tasks/t1/claim']));
  });

  it('Remove… opens the outcome choice; nothing changes until one is chosen', async () => {
    const user = userEvent.setup();
    renderPlant();
    await user.click(await screen.findByLabelText('More plant actions'));
    await user.click(screen.getByRole('button', { name: 'Remove…' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('Take photo opens the picker from the menu', async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    renderPlant();
    await user.click(await screen.findByLabelText('More plant actions'));
    await user.click(screen.getByRole('button', { name: 'Take photo' }));
    const input = click.mock.instances[0] as unknown as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.getAttribute('capture')).toBe('environment');
    click.mockRestore();
  });

  it('a plant with no task says so, and offers to add one', async () => {
    server.use(
      http.get(`${API}/plants/p1`, () =>
        HttpResponse.json(plantBody({ upcomingTasks: [], recentCompletions: [] }))
      )
    );
    renderPlant();
    const card = await screen.findByRole('region', { name: 'What this plant needs now' });
    expect(within(card).getByText('No care scheduled')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /add task/i })).toBeInTheDocument();
  });

  it('a past plant has no status card, and the menu offers Restore instead of Remove', async () => {
    server.use(
      http.get(`${API}/plants/p1`, () => HttpResponse.json(plantBody({ status: 'died' })))
    );
    renderPlant();
    await screen.findByRole('heading', { level: 1, name: 'Peace Lily' });
    expect(screen.queryByRole('region', { name: 'What this plant needs now' })).toBeNull();
    const menu = screen.getByLabelText('More plant actions').closest('details')!;
    expect(within(menu).getByRole('button', { name: 'Restore to active care' })).toBeTruthy();
    expect(within(menu).queryByRole('button', { name: 'Remove…' })).toBeNull();
  });
});

describe('the plant page on desktop', () => {
  it('keeps its own layout', async () => {
    window.matchMedia = phone(false);
    renderPlant();
    await screen.findByRole('heading', { level: 1, name: 'Peace Lily' });
    expect(screen.queryByRole('region', { name: 'What this plant needs now' })).toBeNull();
    expect(screen.getByRole('button', { name: /^remove$/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('More plant actions')).toBeNull();
  });
});

describe('the plant page in the iOS app with bar tools', () => {
  beforeEach(() => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      PluginHeaders: [
        {
          name: 'NativeChrome',
          methods: ['configure', 'update', 'setBarTools'].map((name) => ({ name })),
        },
      ],
    };
  });

  it('puts the "…" menu in the bar and follows its picks', async () => {
    renderPlant();
    await screen.findByRole('region', { name: 'What this plant needs now' });
    await waitFor(() => expect(native.sent.length).toBeGreaterThan(0));
    const tools = native.sent[native.sent.length - 1] as NativeBarTools;
    expect(tools.path).toBe('/plants/p1');
    expect(tools.search).toBeNull();
    expect(tools.menus.map((m) => [m.id, m.symbol])).toEqual([['more', 'ellipsis.circle']]);
    expect(tools.menus[0].groups.flatMap((g) => g.items.map((i) => i.id))).toContain('act:remove');
    expect(screen.queryByLabelText('More plant actions')).toBeNull();

    await act(async () => {
      for (const l of native.listeners.barMenuSelect ?? [])
        l({ path: '/plants/p1', id: 'act:passport' });
      await Promise.resolve();
    });
    expect(await screen.findByText('Passport page')).toBeInTheDocument();
  });
});
