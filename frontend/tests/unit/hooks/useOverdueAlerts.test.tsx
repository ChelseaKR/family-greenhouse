import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOverdueAlerts } from '@/hooks/useOverdueAlerts';
import * as notifications from '@/utils/notifications';
import type { Task } from '@/services/plantService';

const notifySpy = vi.spyOn(notifications, 'notify').mockImplementation(() => {});

beforeEach(() => {
  sessionStorage.clear();
  notifySpy.mockClear();
  vi.spyOn(notifications, 'isEnabledLocally').mockReturnValue(true);
});

const past = new Date(Date.now() - 86_400_000).toISOString();

function task(id: string): Task {
  return {
    id,
    plantId: `plant-${id}`,
    plantName: `Plant ${id}`,
    type: 'water',
    nextDue: past,
  } as unknown as Task;
}

describe('useOverdueAlerts — household scoping (H2)', () => {
  it('seeds the first overdue batch silently (no notification spam on first load)', () => {
    renderHook(() => useOverdueAlerts([task('a'), task('b')], 'hh-1'));
    expect(notifySpy).not.toHaveBeenCalled();
    // Seeded under the household-scoped key.
    expect(sessionStorage.getItem('fg.overdueAlerts.announced.hh-1')).toContain('a');
  });

  it('does not replay household B’s overdue backlog as new when switching households', () => {
    const { rerender } = renderHook(({ tasks, hh }) => useOverdueAlerts(tasks, hh), {
      initialProps: { tasks: [task('a')], hh: 'hh-1' },
    });
    expect(notifySpy).not.toHaveBeenCalled();

    // Switch to household B with its own overdue tasks — should seed silently,
    // NOT fire notifications for the (different) household's backlog.
    rerender({ tasks: [task('x'), task('y')], hh: 'hh-2' });
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('fg.overdueAlerts.announced.hh-2')).toContain('x');
    // The two households keep independent seen-sets.
    expect(sessionStorage.getItem('fg.overdueAlerts.announced.hh-1')).toContain('a');
  });

  it('notifies for a task that newly lapses within the same household', () => {
    const { rerender } = renderHook(({ tasks }) => useOverdueAlerts(tasks, 'hh-1'), {
      initialProps: { tasks: [task('a')] },
    });
    expect(notifySpy).not.toHaveBeenCalled();

    rerender({ tasks: [task('a'), task('b')] });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });
});
