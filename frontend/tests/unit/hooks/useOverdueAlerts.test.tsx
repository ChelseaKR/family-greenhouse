import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useOverdueAlerts } from '@/hooks/useOverdueAlerts';
import * as notifications from '@/utils/notifications';
import type { Task } from '@/services/plantService';

const NOW = new Date('2026-07-25T20:00:00.000Z');
// `notify` reports whether the Notification was actually shown; default to a
// successful send so the dedupe assertions below describe delivered alerts.
const notifySpy = vi.spyOn(notifications, 'notify').mockImplementation(() => true);
const enabledSpy = vi.spyOn(notifications, 'isEnabledLocally');
let enabled = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sessionStorage.clear();
  notifySpy.mockClear();
  notifySpy.mockImplementation(() => true);
  enabled = true;
  enabledSpy.mockImplementation(() => enabled);
});

afterEach(() => {
  vi.useRealTimers();
});

function task(id: string, dueOffsetMs = -86_400_000): Task {
  return {
    id,
    plantId: `plant-${id}`,
    plantName: `Plant ${id}`,
    type: 'water',
    nextDue: new Date(NOW.getTime() + dueOffsetMs).toISOString(),
  } as unknown as Task;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useOverdueAlerts', () => {
  it('seeds the first overdue batch silently (no notification spam on first load)', () => {
    renderHook(() => useOverdueAlerts([task('a'), task('b')], 'hh-1'));
    expect(notifySpy).not.toHaveBeenCalled();
    // Seeded under the household-scoped key.
    expect(sessionStorage.getItem('fg.overdueAlerts.announced.hh-1')).toContain('a');
  });

  it('notifies at the nearest due boundary, then schedules the next task without polling', async () => {
    renderHook(() => useOverdueAlerts([task('a', 1_000), task('b', 2_500)], 'hh-1'));

    await advance(999);
    expect(notifySpy).not.toHaveBeenCalled();

    await advance(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenLastCalledWith(
      'Plant a could use a little care',
      expect.objectContaining({ tag: 'task-a' })
    );

    await advance(1_499);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(notifySpy).toHaveBeenCalledTimes(2);
    expect(notifySpy).toHaveBeenLastCalledWith(
      'Plant b could use a little care',
      expect.objectContaining({ tag: 'task-b' })
    );
  });

  it('reschedules when the task list adds an earlier due transition', async () => {
    const { rerender } = renderHook(({ tasks }) => useOverdueAlerts(tasks, 'hh-1'), {
      initialProps: { tasks: [task('later', 10_000)] },
    });

    rerender({ tasks: [task('later', 10_000), task('earlier', 1_000)] });
    await advance(1_000);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      'Plant earlier could use a little care',
      expect.objectContaining({ tag: 'task-earlier' })
    );
  });

  it('does not replay household B’s overdue backlog and cancels household A’s timer', async () => {
    const { rerender } = renderHook(({ tasks, hh }) => useOverdueAlerts(tasks, hh), {
      initialProps: { tasks: [task('a', 1_000)], hh: 'hh-1' },
    });
    expect(notifySpy).not.toHaveBeenCalled();

    // Switch before household A's due boundary. Household B's existing backlog
    // seeds silently, while its future occurrence receives its own timer.
    rerender({ tasks: [task('x'), task('y', 2_000)], hh: 'hh-2' });
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('fg.overdueAlerts.announced.hh-2')).toContain('x');
    await advance(1_000);
    expect(notifySpy).not.toHaveBeenCalled();
    await advance(1_000);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      'Plant y could use a little care',
      expect.objectContaining({ tag: 'task-y' })
    );
  });

  it('notifies for a task that newly lapses within the same household', () => {
    const { rerender } = renderHook(({ tasks }) => useOverdueAlerts(tasks, 'hh-1'), {
      initialProps: { tasks: [task('a')] },
    });
    expect(notifySpy).not.toHaveBeenCalled();

    rerender({ tasks: [task('a'), task('b')] });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it('reconciles a late suspended timer when the tab becomes visible', () => {
    renderHook(() => useOverdueAlerts([task('a', 5_000)], 'hh-1'));

    // Moving the wall clock does not execute a pending fake timer, which
    // mirrors a suspended background tab or a laptop waking after its due time.
    vi.setSystemTime(new Date(NOW.getTime() + 10_000));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      'Plant a could use a little care',
      expect.objectContaining({ tag: 'task-a' })
    );
  });

  it('does not mark a due task delivered while permission is unavailable, then dedupes it', async () => {
    renderHook(() => useOverdueAlerts([task('a', 1_000)], 'hh-1'));

    enabled = false;
    await advance(1_000);
    expect(notifySpy).not.toHaveBeenCalled();

    enabled = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(notifySpy).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it('retries a task whose notification the browser refused to construct, then dedupes it', async () => {
    // iOS standalone PWAs can throw from `new Notification(...)`; `notify`
    // swallows that and reports `false`. The task must NOT be recorded as
    // announced on that outcome — it used to be, and the alert was then lost
    // for the rest of the session.
    notifySpy.mockImplementation(() => false);
    renderHook(() => useOverdueAlerts([task('a', 1_000)], 'hh-1'));

    await advance(1_000);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('fg.overdueAlerts.announced.hh-1') ?? '').not.toContain('a');

    // Next wake-up: the browser now accepts the notification.
    notifySpy.mockImplementation(() => true);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(notifySpy).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem('fg.overdueAlerts.announced.hh-1')).toContain('a');

    // And now it is deduped like any delivered alert.
    act(() => window.dispatchEvent(new Event('focus')));
    expect(notifySpy).toHaveBeenCalledTimes(2);
  });

  it('cancels the due timer and event listeners on unmount', async () => {
    const { unmount } = renderHook(() => useOverdueAlerts([task('a', 1_000)], 'hh-1'));
    unmount();

    await advance(1_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
