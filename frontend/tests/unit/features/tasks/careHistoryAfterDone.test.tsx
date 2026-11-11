/**
 * After Done, the care history that is already on screen shows the new state.
 *
 * Marking a task done used to patch the task (its next due date) and leave
 * everything else on the page as it was read: the plant page still said "No
 * watering has been logged" and "No care history yet", and the dashboard feed
 * still said nothing had happened, until the page was left and opened again.
 *
 * What is pinned here is not only that the history updates but HOW. The
 * completion response is a task; it does not say who the completion was
 * attributed to, and when someone else got there first it is not this
 * person's completion at all. So nothing is made up on the client: the
 * history shown is the history the server returns, read again after the
 * completion and merged in only once it contains that completion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import { Toaster } from '@/components/Toaster';
import { UNDO_WINDOW_MS, resetDeferredCareQueueForTests } from '@/features/plants/deferredCare';
import { refreshCareHistory, useCompleteTaskMutation } from '@/features/tasks/taskMutations';
import { plantService, type PlantWithTasks, type TaskCompletion } from '@/services/plantService';
import { householdService, type ActivityEvent } from '@/services/householdService';
import { useAuthStore } from '@/store/authStore';
import { useToastStore } from '@/store/toastStore';
import { server } from '../../../msw/server';

const API = 'http://localhost:4000';
const HH = 'hh-1';
const PLANT_KEY = ['plants', HH, 'p1'];
const FEED_KEY = ['household', HH, 'activity'];

function daysFromNow(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 0, 0, 0);
  return d.toISOString();
}

const dueTask = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Peace Lily',
  type: 'water' as const,
  frequency: 7,
  lastCompleted: null as string | null,
  nextDue: daysFromNow(-1),
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
};

/** What POST /tasks/t1/complete answers: the task, advanced. Not who did it. */
function advanced(completedAt: string) {
  return { ...dueTask, lastCompleted: completedAt, nextDue: daysFromNow(7) };
}

function completion(completedAt: string, by = { id: 'u-me', name: 'Me' }): TaskCompletion {
  return {
    id: `c-${by.id}`,
    taskId: 't1',
    taskType: 'water',
    completedBy: by.id,
    completedByName: by.name,
    completedAt,
    notes: null,
  };
}

function plantBody(
  recentCompletions: TaskCompletion[],
  upcomingTasks: unknown[] = [dueTask]
): Record<string, unknown> {
  return {
    id: 'p1',
    householdId: HH,
    name: 'Peace Lily',
    species: null,
    location: 'Bedroom',
    careRule: null,
    imageUrl: null,
    notes: null,
    createdAt: '2026-04-25T00:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-04-25T00:00:00.000Z',
    upcomingTasks,
    recentCompletions,
  };
}

function feedEvent(completedAt: string): ActivityEvent {
  return {
    id: 'c-u-me',
    type: 'task.completed',
    householdId: HH,
    actorId: 'u-me',
    actorName: 'Me',
    occurredAt: completedAt,
    payload: { plantId: 'p1', taskId: 't1', taskType: 'water', notes: null },
  };
}

const desktop = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  onchange: null,
  dispatchEvent: vi.fn(),
})) as never;

const realMatchMedia = window.matchMedia;
let stopWatching: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetDeferredCareQueueForTests();
  useToastStore.setState({ toasts: [] });
  window.matchMedia = desktop;
  useAuthStore.setState({
    accessToken: 'a',
    user: { id: 'u-me', name: 'Me', householdId: HH } as never,
  });
});
afterEach(() => {
  stopWatching.forEach((stop) => stop());
  stopWatching = [];
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('the plant page after Done', () => {
  it('shows the new watering in "Last watered" and Care History without leaving the page', async () => {
    let doneAt: string | null = null;
    server.use(
      http.get(`${API}/plants/p1`, () =>
        HttpResponse.json(plantBody(doneAt ? [completion(doneAt)] : []))
      ),
      http.post(`${API}/tasks/t1/complete`, () => {
        doneAt = new Date().toISOString();
        return HttpResponse.json(advanced(doneAt));
      })
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/plants/p1']}>
          <Routes>
            <Route path="/plants/:plantId" element={<PlantDetailPage />} />
          </Routes>
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // As read on arrival: nobody has watered it.
    const lastWatered = await screen.findByTestId('last-watered');
    expect(lastWatered).toHaveTextContent('No watering has been logged for this plant yet.');
    expect(screen.getByText('No care history yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await pass(UNDO_WINDOW_MS + 100);
    await waitFor(() => expect(doneAt).not.toBeNull());

    // Same page, same mount: the line and the list now say what happened.
    await waitFor(() =>
      expect(screen.getByTestId('last-watered')).toHaveTextContent('Last watered today by Me.')
    );
    expect(screen.getByTestId('last-watered')).toBe(lastWatered);
    expect(screen.queryByText('No care history yet.')).not.toBeInTheDocument();
    // The Care History row: "<name> completed <task>", split across spans.
    expect(
      screen.getByText(
        (_text, element) => element?.tagName === 'P' && element.textContent === 'Me completed water'
      )
    ).toBeInTheDocument();
  });
});

describe('useCompleteTaskMutation and the history on screen', () => {
  /** A cache with the plant page and/or the dashboard feed open on it. */
  function open({ plant = true, feed = false }: { plant?: boolean; feed?: boolean } = {}) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    if (plant) {
      const observer = new QueryObserver(client, {
        queryKey: PLANT_KEY,
        queryFn: () => plantService.getPlant('p1'),
      });
      stopWatching.push(observer.subscribe(() => {}));
    }
    if (feed) {
      const observer = new QueryObserver(client, {
        queryKey: FEED_KEY,
        queryFn: () => householdService.getActivity(HH, 50),
      });
      stopWatching.push(observer.subscribe(() => {}));
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCompleteTaskMutation(HH), { wrapper });
    const done = () =>
      act(() => result.current.mutate({ taskId: 't1', expectedNextDue: dueTask.nextDue }));
    const plantInCache = () => client.getQueryData<PlantWithTasks>(PLANT_KEY);
    return { client, done, plantInCache };
  }

  it('adds the completion the server recorded and keeps the task the completion returned', async () => {
    const doneAt = new Date().toISOString();
    let completed = false;
    server.use(
      // The follow-up read is behind on the TASK (it still has the old due
      // date) but has the completion. Taking the whole read would put the
      // old due date back on screen, which is the bug the "do not refetch
      // right now" rule exists to prevent.
      http.get(`${API}/plants/p1`, () =>
        HttpResponse.json(plantBody(completed ? [completion(doneAt)] : [], [dueTask]))
      ),
      http.post(`${API}/tasks/t1/complete`, () => {
        completed = true;
        return HttpResponse.json(advanced(doneAt));
      })
    );
    const { client, done, plantInCache } = open();
    await waitFor(() => expect(plantInCache()).toBeDefined());
    expect(plantInCache()?.recentCompletions).toEqual([]);

    done();

    await waitFor(() => expect(plantInCache()?.recentCompletions).toEqual([completion(doneAt)]));
    expect(plantInCache()?.upcomingTasks).toEqual([advanced(doneAt)]);
    // Still marked stale for its next mount, exactly as before.
    expect(client.getQueryState(PLANT_KEY)?.isInvalidated).toBe(true);
  });

  it('never shows a guess: nothing is added until the server has the completion', async () => {
    const doneAt = new Date().toISOString();
    let readsAfterDone = 0;
    let completed = false;
    server.use(
      http.get(`${API}/plants/p1`, () => {
        if (!completed) return HttpResponse.json(plantBody([]));
        readsAfterDone += 1;
        // The first read after the completion has not caught up yet.
        return HttpResponse.json(plantBody(readsAfterDone > 1 ? [completion(doneAt)] : []));
      }),
      http.post(`${API}/tasks/t1/complete`, () => {
        completed = true;
        return HttpResponse.json(advanced(doneAt));
      })
    );
    const { done, plantInCache } = open();
    await waitFor(() => expect(plantInCache()).toBeDefined());

    done();

    await waitFor(() => expect(readsAfterDone).toBe(1));
    await pass(50);
    // The task moved (the server said so); the history did not, because the
    // server has not said so yet. No row was written from the client's idea
    // of who did it.
    expect(plantInCache()?.upcomingTasks).toEqual([advanced(doneAt)]);
    expect(plantInCache()?.recentCompletions).toEqual([]);

    await pass(1_000);
    await waitFor(() => expect(plantInCache()?.recentCompletions).toEqual([completion(doneAt)]));
    expect(readsAfterDone).toBe(2);
  });

  it('shows who really did it when someone else got there first', async () => {
    // Sam watered it two hours ago, after this page was read. The server
    // then completes nothing and answers with the task as it stands.
    const samAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const sam = completion(samAt, { id: 'u-sam', name: 'Sam' });
    let asked = false;
    server.use(
      http.get(`${API}/plants/p1`, () => HttpResponse.json(plantBody(asked ? [sam] : []))),
      http.post(`${API}/tasks/t1/complete`, () => {
        asked = true;
        return HttpResponse.json(advanced(samAt));
      })
    );
    const { done, plantInCache } = open();
    await waitFor(() => expect(plantInCache()).toBeDefined());

    done();

    await waitFor(() => expect(plantInCache()?.recentCompletions).toEqual([sam]));
    expect(plantInCache()?.recentCompletions.map((row) => row.completedByName)).not.toContain('Me');
  });

  it('does not read a plant page that is not open', async () => {
    const doneAt = new Date().toISOString();
    let reads = 0;
    server.use(
      http.get(`${API}/plants/p1`, () => {
        reads += 1;
        return HttpResponse.json(plantBody([completion(doneAt)]));
      }),
      http.post(`${API}/tasks/t1/complete`, () => HttpResponse.json(advanced(doneAt)))
    );
    const { client, done, plantInCache } = open({ plant: false });
    // Visited earlier and still cached, but nothing is showing it.
    client.setQueryData(PLANT_KEY, plantBody([]));

    done();

    await waitFor(() => expect(plantInCache()?.upcomingTasks).toEqual([advanced(doneAt)]));
    await pass(5_000);
    expect(reads).toBe(0);
    // It is read again when it is next opened, as before.
    expect(client.getQueryState(PLANT_KEY)?.isInvalidated).toBe(true);
  });

  it('brings an open activity feed up to date', async () => {
    const doneAt = new Date().toISOString();
    let completed = false;
    server.use(
      http.get(`${API}/households/${HH}/activity`, () =>
        HttpResponse.json(completed ? [feedEvent(doneAt)] : [])
      ),
      http.post(`${API}/tasks/t1/complete`, () => {
        completed = true;
        return HttpResponse.json(advanced(doneAt));
      })
    );
    const { client, done } = open({ plant: false, feed: true });
    await waitFor(() => expect(client.getQueryData(FEED_KEY)).toEqual([]));

    done();

    await waitFor(() => expect(client.getQueryData(FEED_KEY)).toEqual([feedEvent(doneAt)]));
    expect(client.getQueryState(FEED_KEY)?.isInvalidated).toBe(true);
  });

  it('reads the feed again when the first read was behind', async () => {
    const doneAt = new Date().toISOString();
    let readsAfterDone = 0;
    let completed = false;
    server.use(
      http.get(`${API}/households/${HH}/activity`, () => {
        if (!completed) return HttpResponse.json([]);
        readsAfterDone += 1;
        return HttpResponse.json(readsAfterDone > 1 ? [feedEvent(doneAt)] : []);
      }),
      http.post(`${API}/tasks/t1/complete`, () => {
        completed = true;
        return HttpResponse.json(advanced(doneAt));
      })
    );
    const { client, done } = open({ plant: false, feed: true });
    await waitFor(() => expect(client.getQueryData(FEED_KEY)).toEqual([]));

    done();

    await waitFor(() => expect(readsAfterDone).toBe(1));
    await pass(50);
    expect(client.getQueryData(FEED_KEY)).toEqual([]);
    await pass(1_000);
    await waitFor(() => expect(client.getQueryData(FEED_KEY)).toEqual([feedEvent(doneAt)]));
  });
});

describe('refreshCareHistory', () => {
  function openPlant(cached: Record<string, unknown>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(PLANT_KEY, cached);
    const observer = new QueryObserver(client, {
      queryKey: PLANT_KEY,
      queryFn: () => plantService.getPlant('p1'),
      staleTime: Infinity,
    });
    stopWatching.push(observer.subscribe(() => {}));
    return client;
  }

  it('never goes backwards: an older read that lands late does not replace a newer list', async () => {
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const later = new Date().toISOString();
    const mine = completion(earlier);
    const newer: TaskCompletion = { ...completion(later), id: 'c-later', taskId: 't2' };
    let reads = 0;
    server.use(
      // This read was served before the newer completion was written.
      http.get(`${API}/plants/p1`, () => {
        reads += 1;
        return HttpResponse.json(plantBody([mine]));
      })
    );
    const client = openPlant(plantBody([newer, mine]));

    await refreshCareHistory(client, HH, advanced(earlier), [0]);

    // The sabotage this guards against only shows if the read happened.
    expect(reads).toBe(1);
    expect(client.getQueryData<PlantWithTasks>(PLANT_KEY)?.recentCompletions).toEqual([
      newer,
      mine,
    ]);
  });

  it('leaves the page as it was, and does not throw, when the read keeps failing', async () => {
    let reads = 0;
    server.use(
      http.get(`${API}/plants/p1`, () => {
        reads += 1;
        return HttpResponse.json({ message: 'Service unavailable' }, { status: 503 });
      })
    );
    const before = plantBody([]);
    const client = openPlant(before);

    await expect(
      refreshCareHistory(client, HH, advanced(new Date().toISOString()), [0, 0, 0])
    ).resolves.toBeUndefined();

    expect(reads).toBe(3);
    expect(client.getQueryData(PLANT_KEY)).toEqual(before);
  });

  it('does nothing for an answer that names no completion', async () => {
    let reads = 0;
    server.use(
      http.get(`${API}/plants/p1`, () => {
        reads += 1;
        return HttpResponse.json(plantBody([]));
      })
    );
    const client = openPlant(plantBody([]));

    await refreshCareHistory(client, HH, { ...dueTask, lastCompleted: null }, [0]);

    expect(reads).toBe(0);
  });
});
