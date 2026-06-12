import { useEffect, useRef } from 'react';
import { Task } from '@/services/plantService';
import { isEnabledLocally, notify } from '@/utils/notifications';

const STORAGE_KEY = 'fg.overdueAlerts.announced';

/** null = nothing persisted yet this browser session (first run). */
function loadAnnounced(): Set<string> | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return null;
  }
}

function saveAnnounced(ids: Set<string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Quota/availability problems just mean we may re-announce later.
  }
}

/**
 * Fires a single browser notification when previously-not-overdue tasks
 * become overdue. Operates as a passive observer over whatever task list the
 * caller has — no polling on its own.
 *
 * On the FIRST run with data in a browser session, the entire currently-
 * overdue batch is seeded as "already seen" WITHOUT notifying — otherwise
 * every navigation back to the dashboard would re-fire the whole backlog.
 * The seen-set is persisted in sessionStorage so remounts (route changes,
 * reloads within the session) stay quiet; only tasks that become overdue
 * afterward notify. A task that leaves the overdue state (completed/
 * snoozed) is un-seen so it can announce again if it lapses later.
 */
export function useOverdueAlerts(tasks: Task[] | undefined): void {
  // Lazily hydrated from sessionStorage on the first run with data.
  const announced = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!tasks || !isEnabledLocally()) return;
    const now = Date.now();
    const overdue = tasks.filter((t) => new Date(t.nextDue).getTime() < now);

    if (announced.current === null) {
      const stored = loadAnnounced();
      if (stored === null) {
        // First run with data this session: seed silently.
        announced.current = new Set(overdue.map((t) => t.id));
        saveAnnounced(announced.current);
        return;
      }
      announced.current = stored;
    }

    let changed = false;

    // Un-see tasks that are present but no longer overdue, so a future
    // lapse re-announces.
    const overdueIds = new Set(overdue.map((t) => t.id));
    for (const t of tasks) {
      if (!overdueIds.has(t.id) && announced.current.delete(t.id)) {
        changed = true;
      }
    }

    for (const t of overdue) {
      if (announced.current.has(t.id)) continue;
      announced.current.add(t.id);
      changed = true;
      notify(`${t.plantName} needs attention`, {
        body: `${t.customType ?? t.type} is overdue.`,
        tag: `task-${t.id}`,
      });
    }

    if (changed) saveAnnounced(announced.current);
  }, [tasks]);
}
