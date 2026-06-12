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

export const runDigests = (): Promise<{ households: number; sent: number }> => runWeeklyDigests();

/** EventBridge can pass a constant input `{ "year": 2026 }` to recap a
 *  specific year; otherwise the previous calendar year is used. */
export const runYearRecap = (
  event?: { year?: number } | null
): Promise<{ households: number; sent: number; year: number }> =>
  runYearRecaps(typeof event?.year === 'number' ? event.year : undefined);

/**
 * Default export used by the deployed Lambda (Terraform configures every
 * function as `handler.handler`). EventBridge rules pass a constant input
 * `{ "job": "weekly" }` or `{ "job": "yearRecap", "year"?: number }` to pick
 * the routine; anything else defaults to the weekly digest, matching the
 * higher-frequency schedule.
 */
export const handler = (
  event?: { job?: string; year?: number } | null
): Promise<{ households: number; sent: number; year?: number }> =>
  event?.job === 'yearRecap' ? runYearRecap(event) : runDigests();
