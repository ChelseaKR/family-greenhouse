/**
 * EventBridge-invoked digest entry points (NOT HTTP routes — same contract as
 * `handlers/reminders/handler.ts`): the scheduler invokes the configured
 * export directly, so there's no API Gateway route, no auth middleware and no
 * request parsing. Each returns a small summary surfaced in CloudWatch logs.
 *
 * Two schedules target this module (see the Terraform notes in the digest
 * feature report / infrastructure/modules/api/main.tf):
 *   - weekly  → `handler.runDigests`    (e.g. cron(0 13 ? * MON *))
 *   - yearly  → `handler.runYearRecap`  (e.g. cron(0 13 2 1 ? *), Jan 2 —
 *     recaps the PREVIOUS calendar year by default)
 *
 * The admin-facing manual triggers live on the notifications HTTP group
 * (`POST /notifications/run-digests`, `POST /notifications/run-year-recap`)
 * and share the same per-household service routines.
 */
import { runWeeklyDigests, runYearRecaps } from '../../services/digest.js';
import { deadlineFrom } from '../../services/scheduledFanOut.js';

/** The Lambda context, narrowed to the one thing these entry points need: its
 *  own countdown, so the fan-out's deadline tracks the Terraform timeout
 *  instead of duplicating it as a constant here. */
type Countdown = { getRemainingTimeInMillis?: () => number } | undefined;

export interface DigestRunSummary {
  households: number;
  attempted: number;
  sent: number;
  failed: number;
  truncated: boolean;
}

export const runDigests = (context?: Countdown): Promise<DigestRunSummary> =>
  runWeeklyDigests(new Date(), { deadlineAt: deadlineFrom(context) });

/** EventBridge can pass a constant input `{ "year": 2026 }` to recap a
 *  specific year; otherwise the previous calendar year is used. */
export const runYearRecap = (
  event?: { year?: number } | null,
  context?: Countdown
): Promise<DigestRunSummary & { year: number }> =>
  runYearRecaps(typeof event?.year === 'number' ? event.year : undefined, new Date(), {
    deadlineAt: deadlineFrom(context),
  });

/**
 * Default export used by the deployed Lambda (Terraform configures every
 * function as `handler.handler`). EventBridge rules pass a constant input
 * `{ "job": "weekly" }` or `{ "job": "yearRecap", "year"?: number }` to pick
 * the routine; anything else defaults to the weekly digest, matching the
 * higher-frequency schedule.
 */
export const handler = (
  event?: { job?: string; year?: number } | null,
  context?: Countdown
): Promise<DigestRunSummary & { year?: number }> =>
  event?.job === 'yearRecap' ? runYearRecap(event, context) : runDigests(context);
