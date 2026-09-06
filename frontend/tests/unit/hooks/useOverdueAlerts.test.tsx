import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useOverdueAlerts } from '@/hooks/useOverdueAlerts';
import { formatDueDate, isOverdue } from '@/utils/date';
import * as notifications from '@/utils/notifications';
import type { Task } from '@/services/plantService';

// 16:00 on the runner's own local calendar day, whatever zone it pins, so
// "earlier today" and "later today" below are unambiguous everywhere. The hook
// classifies by local calendar day, so every fixture is a wall-clock time.
const NOW = (() => {
  const anchor = new Date('2026-07-25T12:00:00Z');
  anchor.setHours(16, 0, 0, 0);
  return anchor;
})();

/** ISO instant for `hour:00` local, `dayOffset` days from NOW's local day. */
function localIso(dayOffset: number, hour: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function msFromNow(iso: string): number {
  return new Date(iso).getTime() - NOW.getTime();
}

const YESTERDAY_MORNING = localIso(-1, 9);
const THIS_MORNING = localIso(0, 9); // already past at NOW, still "Today"
const THIS_EVENING = localIso(0, 22); // still ahead at NOW, also "Today"
const TOMORROW_MORNING = localIso(1, 9);
const IN_THREE_DAYS = localIso(3, 9);

// When each of those turns overdue: local midnight after its due day.
const TONIGHTS_MIDNIGHT = msFromNow(localIso(1, 0));
const TOMORROW_NIGHTS_MIDNIGHT = msFromNow(localIso(2, 0));

const KEY = 'fg.overdueAlerts.announced.hh-1';

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

function task(id: string, nextDue: string = YESTERDAY_MORNING): Task {
  return {
    id,
    plantId: `plant-${id}`,
    plantName: `Plant ${id}`,
    type: 'water',
    nextDue,
  } as unknown as Task;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function announcedIds(key = KEY): Set<string> {
  const raw = sessionStorage.getItem(key);
  return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
}

describe('useOverdueAlerts', () => {
  it('seeds the first overdue batch silently (no notification spam on first load)', () => {
    renderHook(() => useOverdueAlerts([task('a'), task('b')], 'hh-1'));
    expect(notifySpy).not.toHaveBeenCalled();
    // Seeded under the household-scoped key.
    expect(sessionStorage.getItem(KEY)).toContain('a');
  });

  it('notifies at the local-day boundary, then schedules the next day without polling', async () => {
    renderHook(() =>
      useOverdueAlerts([task('a', THIS_EVENING), task('b', TOMORROW_MORNING)], 'hh-1')
    );

    // Nothing due yet has *turned* overdue, so nothing fires all day.
    await advance(TONIGHTS_MIDNIGHT - 1);
    expect(notifySpy).not.toHaveBeenCalled();

    await advance(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenLastCalledWith(
      'Plant a could use a little care',
      expect.objectContaining({ tag: 'task-a' })
    );

    // The whole of the next day passes with one scheduled wake-up, not a poll.
    await advance(TOMORROW_NIGHTS_MIDNIGHT - TONIGHTS_MIDNIGHT - 1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(notifySpy).toHaveBeenCalledTimes(2);
    expect(notifySpy).toHaveBeenLastCalledWith(
      'Plant b could use a little care',
      expect.objectContaining({ tag: 'task-b' })
    );
  });

  it('reschedules when the task list adds an earlier overdue transition', async () => {
    const { rerender } = renderHook(({ tasks }) => useOverdueAlerts(tasks, 'hh-1'), {
      initialProps: { tasks: [task('later', IN_THREE_DAYS)] },
    });

    rerender({ tasks: [task('later', IN_THREE_DAYS), task('earlier', THIS_EVENING)] });
    await advance(TONIGHTS_MIDNIGHT);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      'Plant earlier could use a little care',
      expect.objectContaining({ tag: 'task-earlier' })
    );
  });

  it('does not replay household B’s overdue backlog and cancels household A’s timer', async () => {
    const { rerender } = renderHook(({ tasks, hh }) => useOverdueAlerts(tasks, hh), {
      initialProps: { tasks: [task('a', THIS_EVENING)], hh: 'hh-1' },
    });
    expect(notifySpy).not.toHaveBeenCalled();

    // Switch before household A's boundary. Household B's existing backlog
    // seeds silently, while its future occurrence receives its own timer.
    rerender({ tasks: [task('x'), task('y', TOMORROW_MORNING)], hh: 'hh-2' });
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('fg.overdueAlerts.announced.hh-2')).toContain('x');
    // Household A's task would have turned overdue here; its timer is gone.
    await advance(TONIGHTS_MIDNIGHT);
    expect(notifySpy).not.toHaveBeenCalled();
    await advance(TOMORROW_NIGHTS_MIDNIGHT - TONIGHTS_MIDNIGHT);
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
    renderHook(() => useOverdueAlerts([task('a', THIS_EVENING)], 'hh-1'));

    // Moving the wall clock does not execute a pending fake timer, which
    // mirrors a suspended background tab or a laptop waking the next morning.
    vi.setSystemTime(new Date(NOW.getTime() + TONIGHTS_MIDNIGHT + 60_000));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      'Plant a could use a little care',
      expect.objectContaining({ tag: 'task-a' })
    );
  });

  it('does not mark an overdue task delivered while permission is unavailable, then dedupes it', async () => {
    renderHook(() => useOverdueAlerts([task('a', THIS_EVENING)], 'hh-1'));

    enabled = false;
    await advance(TONIGHTS_MIDNIGHT);
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
    renderHook(() => useOverdueAlerts([task('a', THIS_EVENING)], 'hh-1'));

    await advance(TONIGHTS_MIDNIGHT);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(KEY) ?? '').not.toContain('a');

    // Next wake-up: the browser now accepts the notification.
    notifySpy.mockImplementation(() => true);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(notifySpy).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(KEY)).toContain('a');

    // And now it is deduped like any delivered alert.
    act(() => window.dispatchEvent(new Event('focus')));
    expect(notifySpy).toHaveBeenCalledTimes(2);
  });

  it('cancels the overdue timer and event listeners on unmount', async () => {
    const { unmount } = renderHook(() => useOverdueAlerts([task('a', THIS_EVENING)], 'hh-1'));
    unmount();

    await advance(TONIGHTS_MIDNIGHT);
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(notifySpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // #591: the hook and the dashboard it feeds must answer the same question.
  // The assertions below call the very functions DashboardPage uses to build
  // its Overdue bucket and its row labels (`isOverdue`, `formatDueDate`), so
  // they compare the alert against the screen rather than against a restated
  // rule.
  // ---------------------------------------------------------------------
  describe('agrees with the dashboard it feeds', () => {
    it('stays quiet while the dashboard still labels the task “Today”', async () => {
      renderHook(() => useOverdueAlerts([task('a', THIS_EVENING)], 'hh-1'));

      // Walk past the due instant — the moment the old instant-based
      // predicate fired — and keep going to one millisecond before midnight.
      await advance(TONIGHTS_MIDNIGHT - 1);

      // What the dashboard says about this exact task at this exact instant.
      expect(isOverdue(THIS_EVENING)).toBe(false);
      expect(formatDueDate(THIS_EVENING)).toBe('Today');
      // So the notification must not have fired. It used to, hours earlier.
      expect(notifySpy).not.toHaveBeenCalled();

      // And it fires exactly when the dashboard turns the row red.
      await advance(1);
      expect(isOverdue(THIS_EVENING)).toBe(true);
      expect(formatDueDate(THIS_EVENING)).toBe('Overdue');
      expect(notifySpy).toHaveBeenCalledTimes(1);
    });

    it('never alerts about a task that arrives already due earlier the same day', async () => {
      // The ordinary recurring case: `completeTask` advances `nextDue` from
      // the completion instant, so occurrences land at arbitrary times of day.
      // Arriving on a refetch rather than on mount keeps it out of the silent
      // first-run seed, so nothing but the predicate can suppress the alert.
      const { rerender } = renderHook(({ tasks }) => useOverdueAlerts(tasks, 'hh-1'), {
        initialProps: { tasks: [task('evening', THIS_EVENING)] },
      });
      expect(notifySpy).not.toHaveBeenCalled();

      rerender({ tasks: [task('evening', THIS_EVENING), task('morning', THIS_MORNING)] });

      // The user has the rest of the day for it, and the dashboard says so.
      expect(formatDueDate(THIS_MORNING)).toBe('Today');
      expect(notifySpy).not.toHaveBeenCalled();

      // Still nothing right up to the day boundary.
      await advance(TONIGHTS_MIDNIGHT - 1);
      expect(notifySpy).not.toHaveBeenCalled();
      expect(formatDueDate(THIS_MORNING)).toBe('Today');
    });

    it('holds the same overdue set the dashboard buckets as overdue', () => {
      const tasks = [
        task('yesterday', YESTERDAY_MORNING),
        task('this-morning', THIS_MORNING),
        task('this-evening', THIS_EVENING),
        task('tomorrow', TOMORROW_MORNING),
      ];
      renderHook(() => useOverdueAlerts(tasks, 'hh-1'));

      // The seeded set IS the hook's overdue set on first run.
      const hookOverdue = announcedIds();
      // DashboardPage.tsx: `upcomingTasks?.filter((t) => isOverdue(t.nextDue))`
      const dashboardOverdue = new Set(tasks.filter((t) => isOverdue(t.nextDue)).map((t) => t.id));

      expect(dashboardOverdue).toEqual(new Set(['yesterday']));
      expect(hookOverdue).toEqual(dashboardOverdue);
    });
  });
});
