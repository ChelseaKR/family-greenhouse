import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantsPage } from '@/features/plants/PlantsPage';
import { UNDO_WINDOW_MS, resetDeferredCareQueueForTests } from '@/features/plants/deferredCare';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * In the iOS app the row's menu and the snooze durations are Apple's own
 * action sheet (NativeChrome `present`, via chooseFromMenu). The fake answers
 * like the app: an option's id, or null for Cancel, a swipe or a tap outside.
 */
const native = vi.hoisted(() => ({
  asked: [] as Array<{ title?: string; options: Array<{ id: string; title: string }> }>,
  answers: [] as Array<string | null>,
}));
vi.mock('@/services/nativePresent', () => ({
  chooseFromMenu: (input: { title?: string; options: Array<{ id: string; title: string }> }) => {
    native.asked.push(input);
    return Promise.resolve(native.answers.shift() ?? null);
  },
}));

const API = 'http://localhost:4000';
let writes: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetDeferredCareQueueForTests();
  native.asked.length = 0;
  native.answers.length = 0;
  writes = [];
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    PluginHeaders: [
      {
        name: 'NativeChrome',
        methods: ['configure', 'update', 'present', 'updatePresented', 'dismissPresented'].map(
          (name) => ({ name })
        ),
      },
    ],
  };
  useAuthStore.setState({ accessToken: 'a', user: { id: 'me', householdId: 'hh-1' } as never });
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' && !path.startsWith('/telemetry')) {
      writes.push(`${request.method} ${path}`);
    }
  });
  const due = new Date();
  due.setHours(23, 0, 0, 0);
  server.use(
    http.get(`${API}/plants`, () =>
      HttpResponse.json([
        {
          id: 'p1',
          householdId: 'hh-1',
          name: 'Peace Lily',
          species: null,
          location: null,
          imageUrl: null,
          notes: null,
          createdAt: '',
          createdBy: '',
          updatedAt: '',
        },
      ])
    ),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/tasks`, () =>
      HttpResponse.json([
        {
          id: 't1',
          plantId: 'p1',
          plantName: 'Peace Lily',
          type: 'water',
          frequency: 7,
          lastCompleted: null,
          nextDue: due.toISOString(),
          assignedTo: null,
          assignedToName: null,
          notes: null,
          createdBy: 'x',
          createdAt: '',
        },
      ])
    ),
    http.post(`${API}/tasks/:id/complete`, () => HttpResponse.json({})),
    http.post(`${API}/tasks/:id/snooze`, () => HttpResponse.json({}))
  );
});

afterEach(() => {
  server.events.removeAllListeners();
  vi.useRealTimers();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

function renderPlants() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants']}>
        <Routes>
          <Route path="/plants" element={<PlantsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('row actions in the iOS app', () => {
  it('opens the row menu as an action sheet, and a dismissed sheet writes nothing', async () => {
    renderPlants();
    fireEvent.contextMenu(await screen.findByRole('link', { name: /^Peace Lily/ }));
    await pass(10);
    expect(native.asked[0].title).toBe('Peace Lily');
    expect(native.asked[0].options.map((o) => o.id)).toEqual([
      'done',
      'claim',
      'snooze',
      'move',
      'open',
    ]);
    await pass(UNDO_WINDOW_MS * 2);
    expect(writes).toEqual([]);
  });

  it('Snooze from the sheet asks again for how long, natively, then snoozes', async () => {
    native.answers.push('snooze', '7');
    renderPlants();
    fireEvent.contextMenu(await screen.findByRole('link', { name: /^Peace Lily/ }));
    await pass(50);
    expect(native.asked.map((a) => a.title)).toEqual(['Peace Lily', 'Snooze']);
    expect(writes).toEqual(['POST /tasks/t1/snooze']);
  });

  it('Water now from the sheet waits out the Undo window', async () => {
    native.answers.push('done');
    renderPlants();
    fireEvent.contextMenu(await screen.findByRole('link', { name: /^Peace Lily/ }));
    await pass(50);
    expect(writes).toEqual([]);
    await pass(UNDO_WINDOW_MS + 100);
    expect(writes).toEqual(['POST /tasks/t1/complete']);
  });
});
