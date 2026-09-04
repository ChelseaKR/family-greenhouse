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
 * Two passes run here, sequentially and independently:
 *
 *   1. `remindAllHouseholds` — the per-member due-task roll-up.
 *   2. `runHouseholdEmails`  — the household emails (`services/householdEmails.ts`):
 *      offers up long-overdue unassigned tasks, and delivers anything queued by
 *      the event-driven household emails whose recipient was inside their quiet
 *      hours when it fired.
 *
 * The second pass rides this schedule rather than getting an EventBridge rule
 * of its own so it needs no Terraform change to start working, and because the
 * hourly cadence is exactly what a deferred quiet-hours send wants. A failure
 * in either pass is reported in its own summary and never aborts the other:
 * `households: 0` from a broken run must not be readable as "nobody had
 * anything due".
 */
import { remindAllHouseholds } from '../../services/reminders.js';
import {
  runHouseholdEmails,
  type HouseholdEmailRunSummary,
} from '../../services/householdEmails.js';
import { logger } from '../../utils/logger.js';

export interface ReminderRunSummary {
  households: number;
  sent: number;
  failed: number;
  /** null when the household-email pass threw outright — an explicit "we do
   *  not know", never a zeroed summary that reads like a calm hour. */
  householdEmails: HouseholdEmailRunSummary | null;
}

export const handler = async (): Promise<ReminderRunSummary> => {
  const reminders = await remindAllHouseholds();
  let householdEmails: HouseholdEmailRunSummary | null = null;
  try {
    householdEmails = await runHouseholdEmails();
  } catch (err) {
    logger.error(
      { err: (err as Error).message, msg: 'household_email.run_failed' },
      'household_email.run_failed'
    );
  }
  return { ...reminders, householdEmails };
};
