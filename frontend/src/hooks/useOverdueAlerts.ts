import { useEffect, useRef } from 'react';
import { Task } from '@/services/plantService';
import { isEnabledLocally, notify } from '@/utils/notifications';

/**
 * Fires a single browser notification when previously-not-overdue tasks
 * become overdue. Operates as a passive observer over whatever task list the
 * caller has — no polling on its own. Tasks already-known to be overdue at
 * mount are not re-announced.
 */
export function useOverdueAlerts(tasks: Task[] | undefined): void {
  const announced = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!tasks || !isEnabledLocally()) return;
    const now = Date.now();
    const overdue = tasks.filter((t) => new Date(t.nextDue).getTime() < now);
    for (const t of overdue) {
      if (announced.current.has(t.id)) continue;
      announced.current.add(t.id);
      notify(`${t.plantName} needs attention`, {
        body: `${t.customType ?? t.type} is overdue.`,
        tag: `task-${t.id}`,
      });
    }
  }, [tasks]);
}
