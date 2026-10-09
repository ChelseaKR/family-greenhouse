import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import type { Task } from '@/services/plantService';

const mocks = vi.hoisted(() => ({
  completeTask: vi.fn(),
  snoozeTask: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  playHaptic: vi.fn(),
  t: vi.fn((key: string, options?: { plant?: string }) =>
    options?.plant ? `${key}:${options.plant}` : key
  ),
}));
vi.mock('@/services/taskService', () => ({
  taskService: { completeTask: mocks.completeTask, snoozeTask: mocks.snoozeTask },
}));
vi.mock('@/store/toastStore', () => ({ toast: mocks.toast }));
vi.mock('@/services/nativeHaptics', () => ({ playHaptic: mocks.playHaptic }));
vi.mock('@/i18n', () => ({ default: { t: mocks.t } }));

import { completionLanded, runPushAction, snoozeLanded } from '@/services/pushActionRunner';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
/** The occurrence the reminder was about: due two hours ago. */
const DUE = iso(-2 * HOUR);

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    plantId: 'p1',
    plantName: 'Fern',
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: DUE,
    assignedTo: null,
    assignedToName: null,
    assignmentSource: null,
    notes: null,
    ...over,
  } as Task;
}

const queryClient = { invalidateQueries: vi.fn() } as unknown as QueryClient;

function duplicateCareError(plantName: string): AxiosError {
  return new AxiosError('conflict', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 409,
    data: {
      message: 'Bo already logged water for Fern.',
      details: {
        code: 'DUPLICATE_CARE',
        plantName,
        duplicate: {
          completionId: 'c1',
          completedAt: iso(-10 * 60 * 1000),
          completedBy: 'u2',
          completedByName: 'Bo',
          taskId: 't1',
          taskType: 'water',
          sameTask: true,
          windowHours: 6,
        },
      },
    },
  } as AxiosResponse);
}

describe('running a push action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('Done completes the occurrence the reminder named, refreshes the lists and says so', async () => {
    mocks.completeTask.mockResolvedValue(task({ lastCompleted: iso(-500), nextDue: iso(7 * DAY) }));

    const outcome = await runPushAction(
      { action: 'done', taskId: 't1', plantId: 'p1', expectedNextDue: DUE },
      queryClient
    );

    expect(outcome).toBe('done');
    expect(mocks.completeTask).toHaveBeenCalledWith('t1', { expectedNextDue: DUE });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['plants'] });
    expect(mocks.playHaptic).toHaveBeenCalledWith('completed');
    expect(mocks.toast.success).toHaveBeenCalledWith('pushActions.done:Fern');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('Snooze pushes the occurrence to tomorrow and says so', async () => {
    mocks.snoozeTask.mockResolvedValue(task({ nextDue: iso(DAY) }));

    const outcome = await runPushAction(
      { action: 'snooze', taskId: 't1', expectedNextDue: DUE },
      queryClient
    );

    expect(outcome).toBe('snoozed');
    expect(mocks.snoozeTask).toHaveBeenCalledWith('t1', 1, { expectedNextDue: DUE });
    expect(mocks.playHaptic).toHaveBeenCalledWith('snoozed');
    expect(mocks.toast.success).toHaveBeenCalledWith('pushActions.snoozed:Fern');
  });

  it('reports a Done that changed nothing as already handled, never as done', async () => {
    // The server answers with the current row: completed by someone else
    // yesterday and already moved on, so the stale `expectedNextDue` was a
    // no-op there.
    mocks.completeTask.mockResolvedValue(task({ lastCompleted: iso(-DAY), nextDue: iso(6 * DAY) }));

    const outcome = await runPushAction(
      { action: 'done', taskId: 't1', expectedNextDue: DUE },
      queryClient
    );

    expect(outcome).toBe('already');
    expect(mocks.playHaptic).not.toHaveBeenCalled();
    expect(mocks.toast.info).toHaveBeenCalledWith('pushActions.already:Fern');
    expect(mocks.toast.success).not.toHaveBeenCalled();
    // The screen still refreshes: whatever it showed is out of date either way.
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('reports a Snooze that changed nothing as already handled', async () => {
    mocks.snoozeTask.mockResolvedValue(task({ nextDue: iso(5 * DAY) }));

    const outcome = await runPushAction(
      { action: 'snooze', taskId: 't1', expectedNextDue: DUE },
      queryClient
    );

    expect(outcome).toBe('already');
    expect(mocks.toast.info).toHaveBeenCalledWith('pushActions.already:Fern');
  });

  it('treats a double-care refusal as already handled, without insisting', async () => {
    mocks.completeTask.mockRejectedValue(duplicateCareError('Fern'));

    const outcome = await runPushAction(
      { action: 'done', taskId: 't1', expectedNextDue: DUE },
      queryClient
    );

    expect(outcome).toBe('already');
    expect(mocks.completeTask).toHaveBeenCalledTimes(1);
    expect(mocks.completeTask.mock.calls[0][1]).not.toHaveProperty('confirmDuplicate');
    expect(mocks.toast.info).toHaveBeenCalledWith('pushActions.already:Fern');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('fails safely when the request cannot be made: nothing refreshed, one error toast', async () => {
    mocks.completeTask.mockRejectedValue(new Error('Network Error'));

    const outcome = await runPushAction(
      { action: 'done', taskId: 't1', expectedNextDue: DUE },
      queryClient
    );

    expect(outcome).toBe('failed');
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(mocks.playHaptic).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('pushActions.failed');
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('works without a query client and names an unnamed plant honestly', async () => {
    mocks.completeTask.mockResolvedValue(task({ plantName: '   ', lastCompleted: iso(-500) }));

    await expect(
      runPushAction({ action: 'done', taskId: 't1', expectedNextDue: DUE }, null)
    ).resolves.toBe('done');
    expect(mocks.toast.success).toHaveBeenCalledWith('pushActions.done:pushActions.unnamedPlant');
  });
});

describe('reading whether an action landed', () => {
  const now = NOW.getTime();

  it('a completion landed when it is dated just now', () => {
    expect(completionLanded(task({ lastCompleted: iso(-1000) }), now)).toBe(true);
    expect(completionLanded(task({ lastCompleted: iso(4 * 60 * 1000) }), now)).toBe(true);
    expect(completionLanded(task({ lastCompleted: iso(-DAY) }), now)).toBe(false);
    expect(completionLanded(task({ lastCompleted: null }), now)).toBe(false);
    expect(completionLanded(task({ lastCompleted: 'not a date' }), now)).toBe(false);
  });

  it('a snooze landed when the due date moved one day from where the server bases it', () => {
    // Overdue: based on now.
    expect(snoozeLanded(task({ nextDue: iso(DAY) }), DUE, now)).toBe(true);
    // Due later today: based on the due date itself.
    const later = iso(3 * HOUR);
    expect(snoozeLanded(task({ nextDue: iso(DAY + 3 * HOUR) }), later, now)).toBe(true);
    expect(snoozeLanded(task({ nextDue: iso(DAY) }), later, now)).toBe(false);
    // Nothing to compare against: based on now.
    expect(snoozeLanded(task({ nextDue: iso(DAY) }), undefined, now)).toBe(true);
    expect(snoozeLanded(task({ nextDue: iso(5 * DAY) }), DUE, now)).toBe(false);
    expect(snoozeLanded(task({ nextDue: 'not a date' }), DUE, now)).toBe(false);
  });
});
