import { useEffect, useRef } from 'react';
import { Task } from '@/services/plantService';
import { isEnabledLocally, notify } from '@/utils/notifications';

const STORAGE_KEY_PREFIX = 'fg.overdueAlerts.announced';
// Browsers clamp larger delays to an implementation-specific value (and some
// runtimes wrap them to near-zero). A task more than ~24.8 days away gets one
// long checkpoint, then the exact remaining delay is scheduled.
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Per-household storage key so switching households doesn't replay (or
 *  suppress) the other household's overdue backlog. */
function storageKey(householdId: string | null | undefined): string {
  return householdId ? `${STORAGE_KEY_PREFIX}.${householdId}` : STORAGE_KEY_PREFIX;
}

/** null = nothing persisted yet this browser session (first run). */
function loadAnnounced(key: string): Set<string> | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return null;
  }
}

function saveAnnounced(key: string, ids: Set<string>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Quota/availability problems just mean we may re-announce later.
  }
}

/**
 * Fires a single browser notification when previously-not-overdue tasks
 * become overdue. The hook schedules one timeout for the nearest future due
 * date, then reschedules after that boundary; it does not poll.
 *
 * On the FIRST run with data in a browser session, the entire currently-
 * overdue batch is seeded as "already seen" WITHOUT notifying — otherwise
 * every navigation back to the dashboard would re-fire the whole backlog.
 * The seen-set is persisted in sessionStorage so remounts (route changes,
 * reloads within the session) stay quiet; only tasks that become overdue
 * afterward notify. A task that leaves the overdue state (completed/
 * snoozed) is un-seen so it can announce again if it lapses later.
 *
 * The seen-set is keyed by the active household id: both the in-memory ref
 * and the sessionStorage key are household-scoped, and the ref resets when
 * the household changes. Otherwise switching households replays household
 * B's entire overdue backlog as "newly overdue" (notification spam).
 */
export function useOverdueAlerts(
  tasks: Task[] | undefined,
  householdId: string | null | undefined
): void {
  // Lazily hydrated from sessionStorage on the first run with data.
  const announced = useRef<Set<string> | null>(null);
  // Tracks which household the ref currently belongs to, so a household
  // switch discards the previous household's in-memory seen-set.
  const announcedHousehold = useRef<string | null | undefined>(householdId);

  useEffect(() => {
    const key = storageKey(householdId);
    let timeoutId: number | undefined;
    let disposed = false;

    // Household changed since the ref was hydrated: drop the stale seen-set
    // so it re-hydrates from this household's own storage key below.
    if (announcedHousehold.current !== householdId) {
      announced.current = null;
      announcedHousehold.current = householdId;
    }

    const clearScheduled = () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const reconcile = () => {
      if (disposed) return;
      clearScheduled();

      // Re-check at every wake-up. Notification permission can be revoked in
      // browser settings while this tab is open; in that case do not mark a
      // task announced, so granting permission later can still deliver it.
      if (!tasks || !isEnabledLocally()) return;

      const now = Date.now();
      const scheduledTasks = tasks
        .map((task) => ({ task, dueAt: new Date(task.nextDue).getTime() }))
        .filter((entry) => Number.isFinite(entry.dueAt));
      const overdue = scheduledTasks.filter(({ dueAt }) => dueAt <= now);

      if (announced.current === null) {
        const stored = loadAnnounced(key);
        if (stored === null) {
          // First run with data this session: seed silently.
          announced.current = new Set(overdue.map(({ task }) => task.id));
          saveAnnounced(key, announced.current);
        } else {
          announced.current = stored;
        }
      }

      let changed = false;

      // Un-see tasks that are present but no longer overdue, so a completed,
      // snoozed, or rescheduled occurrence can announce when it lapses later.
      const overdueIds = new Set(overdue.map(({ task }) => task.id));
      for (const { task } of scheduledTasks) {
        if (!overdueIds.has(task.id) && announced.current.delete(task.id)) {
          changed = true;
        }
      }

      for (const { task } of overdue) {
        if (announced.current.has(task.id)) continue;
        announced.current.add(task.id);
        changed = true;
        notify(`${task.plantName} could use a little care`, {
          body: `${task.customType ?? task.type} is ready whenever you are.`,
          tag: `task-${task.id}`,
        });
      }

      if (changed) saveAnnounced(key, announced.current);

      const nextDueAt = scheduledTasks.reduce(
        (nearest, { dueAt }) => (dueAt > now && dueAt < nearest ? dueAt : nearest),
        Number.POSITIVE_INFINITY
      );
      if (Number.isFinite(nextDueAt)) {
        timeoutId = window.setTimeout(reconcile, Math.min(nextDueAt - now, MAX_TIMEOUT_MS));
      }
    };

    // Timers can be suspended in background tabs or fire late after a laptop
    // sleeps. Reconcile immediately when the page becomes active/restored so
    // wall-clock changes cannot leave an already-due task waiting on a stale
    // timeout. These are event-driven checkpoints, not an interval.
    const reconcileWhenVisible = () => {
      if (document.visibilityState === 'visible') reconcile();
    };
    document.addEventListener('visibilitychange', reconcileWhenVisible);
    window.addEventListener('focus', reconcile);
    window.addEventListener('pageshow', reconcile);
    reconcile();

    return () => {
      disposed = true;
      clearScheduled();
      document.removeEventListener('visibilitychange', reconcileWhenVisible);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('pageshow', reconcile);
    };
  }, [tasks, householdId]);
}
