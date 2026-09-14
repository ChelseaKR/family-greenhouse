/**
 * EventBridge-invoked hourly reminder scan across every household.
 *
 * This is NOT an HTTP route — the scheduler invokes the Lambda's `handler`
 * directly with a scheduled event, so there's no API Gateway route, no auth
 * middleware, and no request parsing. It simply runs the fan-out and returns a
 * small summary (surfaced in CloudWatch logs / the invocation result).
 *
 * Wiring: `infrastructure/modules/api/main.tf` defines the Lambda (via the
 * `lambda_handlers` map) and the `aws_cloudwatch_event_rule` that triggers it.
 *
 * Three passes run here, sequentially and independently:
 *
 *   1. `remindAllHouseholds` — the per-member due-task roll-up.
 *   2. `runHouseholdEmails`  — the household emails (`services/householdEmails.ts`):
 *      offers up long-overdue unassigned tasks, and delivers anything queued by
 *      the event-driven household emails whose recipient was inside their quiet
 *      hours when it fired.
 *   3. `runConfirmReminders` — the ONE automatic reminder for an account that
 *      signed up and never confirmed its email (`services/confirmReminders.ts`).
 *
 * The second pass rides this schedule rather than getting an EventBridge rule
 * of its own so it needs no Terraform change to start working, and because the
 * hourly cadence is exactly what a deferred quiet-hours send wants. A failure
 * in either pass is reported in its own summary and never aborts the other:
 * `households: 0` from a broken run must not be readable as "nobody had
 * anything due".
 *
 * The third pass rides it for the same reasons and one more: the deploy
 * workflows publish Lambda code from a fixed list of handler names, so a new
 * function would keep running its placeholder bundle. Riding this one also
 * gives the pass this function's existing per-function error alarm and DLQ.
 */
import { remindAllHouseholds } from '../../services/reminders.js';
import {
  runHouseholdEmails,
  type HouseholdEmailRunSummary,
} from '../../services/householdEmails.js';
import {
  runConfirmReminders,
  type ConfirmReminderRunSummary,
} from '../../services/confirmReminders.js';
import { deadlineFrom } from '../../services/scheduledFanOut.js';
import { logger } from '../../utils/logger.js';

/**
 * Share of the invocation's remaining time the reminder pass may spend.
 *
 * Both passes ride this one 30-second Lambda, sequentially. Before the passes
 * had a clock, the first one could consume the entire invocation and be killed
 * — and then the second never ran AT ALL, every hour, with nothing in the
 * summary saying so. Giving the reminder pass a share rather than the whole
 * budget is what guarantees the household-email pass gets a turn; whatever the
 * reminder pass leaves unspent is still available to it, because its deadline
 * is computed from the clock at the moment it starts.
 *
 * Reminders get the larger share because they are the time-critical half: a
 * household email that waits an hour is a household email that waits an hour,
 * while a reminder that waits is a reminder that may miss its day.
 */
const REMINDER_BUDGET_SHARE = 0.6;

export interface ReminderRunSummary {
  households: number;
  /** Households the reminder pass reached. Below `households` when the pass
   *  stopped on its deadline; `truncated` says so explicitly. */
  attempted: number;
  sent: number;
  failed: number;
  truncated: boolean;
  /** null when the household-email pass threw outright — an explicit "we do
   *  not know", never a zeroed summary that reads like a calm hour. */
  householdEmails: HouseholdEmailRunSummary | null;
  /** null when the confirm-reminder pass threw outright, for the same reason. */
  confirmReminders: ConfirmReminderRunSummary | null;
}

export const handler = async (
  _event?: unknown,
  context?: { getRemainingTimeInMillis?: () => number }
): Promise<ReminderRunSummary> => {
  const reminders = await remindAllHouseholds(new Date(), {
    deadlineAt: deadlineFrom(context, REMINDER_BUDGET_SHARE),
  });
  let householdEmails: HouseholdEmailRunSummary | null = null;
  try {
    // Recomputed here, not up front: the household-email pass gets whatever
    // the reminder pass did not need, which on a normal hour is nearly all of
    // it.
    householdEmails = await runHouseholdEmails(new Date(), { deadlineAt: deadlineFrom(context) });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, msg: 'household_email.run_failed' },
      'household_email.run_failed'
    );
  }
  let confirmReminders: ConfirmReminderRunSummary | null = null;
  try {
    // Last, on whatever time is left. A sign-up can be reminded at any point
    // in a six-day window, so an hour in which this pass is squeezed out loses
    // nothing the next hour cannot do. It never throws past here, so it can
    // never make EventBridge retry the two passes above. The log line carries
    // the error's name only: nothing that could hold an address.
    confirmReminders = await runConfirmReminders(new Date(), { deadlineAt: deadlineFrom(context) });
  } catch (err) {
    logger.error(
      { errorName: (err as Error).name, msg: 'confirm_reminders.run_failed' },
      'confirm_reminders.run_failed'
    );
  }
  return { ...reminders, householdEmails, confirmReminders };
};
