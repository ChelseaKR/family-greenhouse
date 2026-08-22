/**
 * The optimistic next-due date the task list shows the instant you tap
 * "Complete" is a CLIENT-COMPUTED GUESS rendered in the same place, the same
 * typeface, and with the same confidence as the authoritative date the server
 * is about to write.
 *
 * `backend/src/services/taskService.ts` (`completeTask`) computes
 * `nextDue.setDate(nextDue.getDate() + frequency)` in the process zone, and
 * the deployed Lambdas run in UTC (nothing in `infrastructure/` sets `TZ`;
 * `backend/vitest.config.ts` pins the same). `taskMutations.ts` ran the
 * identical expression in the BROWSER's zone. Those agree only while no DST
 * transition falls inside the recurrence window — and when one does, the hour
 * they differ by is enough to move the rendered calendar date a whole day.
 * The row showed one date and then visibly jumped to another when the
 * mutation resolved.
 *
 * These tests assert the optimistic value equals what the server will write,
 * across both transitions, and pin the (unchanged, separately-tracked)
 * month-end behaviour so a future change to it is a deliberate one.
 *
 * TZ is pinned to America/New_York in vitest.config.ts. Verify it took effect
 * rather than asserting nonsense under an exported TZ. Fixtures are given as
 * absolute UTC instants so the input is unambiguous either way.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCompleteTaskMutation } from '@/features/tasks/taskMutations';
import { taskService } from '@/services/taskService';
import type { Task } from '@/services/plantService';

vi.mock('@/services/taskService', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/taskService')>('@/services/taskService');
  return { ...actual, taskService: { ...actual.taskService, completeTask: vi.fn() } };
});

// EST is UTC-5 → 300 minutes in January. If the TZ override didn't reach the
// native tzset, a "browser-zone vs UTC" test proves nothing; skip instead.
const tzActive = new Date('2026-01-15T12:00:00Z').getTimezoneOffset() === 300;

const HOUSEHOLD = 'hh-1';
const TASKS_KEY = ['tasks', HOUSEHOLD, 'all'] as const;

/**
 * Exactly what `completeTask` computes server-side: `setDate(getDate() + N)`
 * evaluated with the process zone set to UTC, which is `setUTCDate` here.
 * Written out rather than hardcoded so the expectation is the server's rule,
 * not a copy of this module's implementation.
 */
function serverNextDue(completedAtIso: string, frequency: number): string {
  const d = new Date(completedAtIso);
  d.setUTCDate(d.getUTCDate() + frequency);
  return d.toISOString();
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    plantId: 'p-1',
    plantName: 'Monstera',
    type: 'water',
    frequency: 7,
    nextDue: '2027-03-14T04:30:00.000Z',
    lastCompleted: null,
    ...overrides,
  } as unknown as Task;
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/**
 * Complete a task and read back the date the list is now showing. The
 * mutation is left permanently in flight so the value under assertion is the
 * OPTIMISTIC one — the server's answer never arrives to paper over it.
 */
async function optimisticNextDueAfterCompleting(
  completedAt: string,
  frequency: number
): Promise<string> {
  // `shouldAdvanceTime` keeps the clock moving so react-query's async
  // `onMutate` and `waitFor`'s polling still make progress while the wall
  // clock is pinned to the fixture instant.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(completedAt));
  try {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const seeded = task({ frequency });
    queryClient.setQueryData(TASKS_KEY, [seeded]);
    vi.mocked(taskService.completeTask).mockReturnValue(new Promise<never>(() => {}));

    const { result } = renderHook(() => useCompleteTaskMutation(HOUSEHOLD), {
      wrapper: wrapper(queryClient),
    });
    act(() => {
      result.current.mutate({ taskId: seeded.id, expectedNextDue: seeded.nextDue });
    });
    await waitFor(() => {
      const rows = queryClient.getQueryData<Task[]>(TASKS_KEY);
      expect(rows?.[0].lastCompleted).not.toBeNull();
    });
    return queryClient.getQueryData<Task[]>(TASKS_KEY)![0].nextDue;
  } finally {
    vi.useRealTimers();
  }
}

describe.runIf(tzActive)('optimistic next-due matches the server across DST', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('spring-forward: does not render the schedule a day earlier than the server will', async () => {
    // Fri 2027-03-12 23:30 EST, seven days out. The window contains the
    // 2027-03-14 spring-forward, so seven LOCAL days is 167 hours while the
    // server's seven UTC days is 168 — and the two land on different local
    // calendar dates.
    const completedAt = '2027-03-13T04:30:00.000Z';
    expect(await optimisticNextDueAfterCompleting(completedAt, 7)).toBe(
      serverNextDue(completedAt, 7)
    );
  });

  it('fall-back: does not render the schedule a day later than the server will', async () => {
    // Sat 2026-10-31 00:30 EDT; the window contains the 2026-11-01 fall-back,
    // making seven local days 169 hours.
    const completedAt = '2026-10-31T04:30:00.000Z';
    expect(await optimisticNextDueAfterCompleting(completedAt, 7)).toBe(
      serverNextDue(completedAt, 7)
    );
  });

  it('positive control: a window with no transition already agreed and still does', async () => {
    const completedAt = '2026-06-01T20:00:00.000Z';
    expect(await optimisticNextDueAfterCompleting(completedAt, 3)).toBe('2026-06-04T20:00:00.000Z');
  });

  it('characterization: a 30-day "monthly" task from Jan 31 lands on Mar 2, as the server does', async () => {
    // `frequency` is a day count, not a month count (see #342): there is no
    // month arithmetic anywhere in the system. Pinned here so the client and
    // the server keep giving the same answer if that ever changes.
    const completedAt = '2027-01-31T12:00:00.000Z';
    expect(await optimisticNextDueAfterCompleting(completedAt, 30)).toBe(
      '2027-03-02T12:00:00.000Z'
    );
  });
});
