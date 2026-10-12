import type { QueryClient } from '@tanstack/react-query';
import i18n from '@/i18n';
import { taskService } from '@/services/taskService';
import type { Task } from '@/services/plantService';
import { toast } from '@/store/toastStore';
import { playHaptic } from '@/services/nativeHaptics';
import { readDuplicateCare } from '@/features/tasks/doubleCare';
import type { PushActionOutcome, PushActionRequest } from './pushActions';

/** "Snooze until tomorrow" is one day, on every platform. */
export const SNOOZE_DAYS = 1;

/**
 * The part of a push action that talks to the server, called by
 * `pushActions.performPushAction` (see that file for the whole picture).
 *
 * What it says afterwards has to be true. The complete and snooze endpoints
 * answer with the task as it now is, whether or not this request changed it
 * (a stale `expectedNextDue` is a no-op by design), so the outcome is read
 * from the task rather than assumed: a completion that landed is dated
 * moments ago, and a snooze that landed moved the due date by exactly
 * {@link SNOOZE_DAYS} from where the server bases it. Anything else is
 * reported as already handled, never as done.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How fresh a completion must be to be this request's own. */
const RECENT_MS = 5 * 60 * 1000;

/** Did this request's completion land? True when the task was completed just now. */
export function completionLanded(task: Task, now: number): boolean {
  const at = task.lastCompleted ? Date.parse(task.lastCompleted) : NaN;
  return Number.isFinite(at) && now - at <= RECENT_MS && at - now <= RECENT_MS;
}

/**
 * Did this request's snooze land? The server moves the due date to
 * max(now, current due) + N days (`taskService.snoozeTaskWithOutcome`), so a
 * landed snooze is that far from where it started, within a small tolerance
 * for the clocks on either side.
 */
export function snoozeLanded(
  task: Task,
  expectedNextDue: string | undefined,
  now: number
): boolean {
  const after = Date.parse(task.nextDue);
  if (!Number.isFinite(after)) return false;
  const before = expectedNextDue ? Date.parse(expectedNextDue) : NaN;
  const base = Number.isFinite(before) ? Math.max(now, before) : now;
  return Math.abs(after - (base + SNOOZE_DAYS * DAY_MS)) <= RECENT_MS;
}

export async function runPushAction(
  request: PushActionRequest,
  queryClient: QueryClient | null
): Promise<PushActionOutcome> {
  const now = Date.now();
  let outcome: PushActionOutcome;
  let plant: string;
  try {
    if (request.action === 'done') {
      const task = await taskService.completeTask(request.taskId, {
        expectedNextDue: request.expectedNextDue,
      });
      plant = task.plantName;
      outcome = completionLanded(task, now) ? 'done' : 'already';
    } else {
      const task = await taskService.snoozeTask(request.taskId, SNOOZE_DAYS, {
        expectedNextDue: request.expectedNextDue,
      });
      plant = task.plantName;
      outcome = snoozeLanded(task, request.expectedNextDue, now) ? 'snoozed' : 'already';
    }
  } catch (error) {
    // Another member logged the same care inside the double-care window: the
    // server declined to log it twice. That is "already handled", and the
    // notification is not the place to insist (`confirmDuplicate`).
    const duplicate = readDuplicateCare(error);
    if (!duplicate) {
      toast.error(i18n.t('pushActions.failed'));
      return 'failed';
    }
    outcome = 'already';
    plant = duplicate.plantName;
  }

  // Whatever the screen shows is now stale: the task list, the dashboard's
  // upcoming card and the plant page all read these prefixes.
  void queryClient?.invalidateQueries({ queryKey: ['tasks'] });
  void queryClient?.invalidateQueries({ queryKey: ['plants'] });

  if (outcome === 'done') playHaptic('completed');
  if (outcome === 'snoozed') playHaptic('snoozed');
  const name = plant.trim() || i18n.t('pushActions.unnamedPlant');
  const message = i18n.t(`pushActions.${outcome}`, { plant: name });
  if (outcome === 'already') toast.info(message);
  else toast.success(message);
  return outcome;
}
