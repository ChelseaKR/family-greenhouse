/**
 * An announced plan-price change (#710), as a pure, validated value.
 *
 * `legal.terms.priceChanges.body` promises: a new price applies to new
 * subscriptions; a running subscription keeps the price it started at; and
 * if one ever has to move, the household's admins are emailed at least 14
 * days before the new price takes effect, "and the price does not move
 * until that has been done". `docs/billing.md` § _Price changes, and the
 * notice nothing sends_ recorded that the send path itself was, deliberately,
 * not built ahead of need. This module is the input contract for the sender
 * that closes that gap (`services/priceChangeNotices.ts`); the CLI operators
 * actually run is `backend/scripts/sendPriceChangeNotice.ts`.
 *
 * Nothing here calls Stripe or touches a running subscription — see
 * `backend/tests/unit/config/priceChangeNoticeGate.ts` for the list of calls
 * that can, and the ledger (`docs/price-change-notices.json`) those calls
 * must be covered by. Sending this notice is what EARNS an entry in that
 * ledger; it does not require one, because the gate's own evaluator already
 * accepts "an email that is out while the code is not written yet".
 */
import { isPlanId, type PlanId } from './plans.js';

/** The two recurring cadences a subscriber can be moved between. Lifetime is
 *  a one-time purchase withdrawn from sale, not a price a running
 *  subscription renews at, so it is out of scope for this notice. */
export type NoticeInterval = 'month' | 'year';

export const MIN_NOTICE_DAYS = 14;

export interface PriceChangeAnnouncement {
  /** Stable id, e.g. `garden-monthly-2026-11-01`. Scopes the per-recipient
   *  "already notified" marker and becomes the ledger entry's `id`. */
  id: string;
  planId: PlanId;
  interval: NoticeInterval;
  /** What is changing and why — carried into the ledger entry's `summary`
   *  and appended to the email body. Never the whole email on its own. */
  summary: string;
  oldPriceUsd: number;
  newPriceUsd: number;
  /** YYYY-MM-DD the new price takes effect. Must be at least
   *  `MIN_NOTICE_DAYS` after the day the notice is actually sent. */
  effectiveOn: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * Whole days since 1970-01-01 for a real calendar date, else null. Mirrors
 * `priceChangeNoticeGate.ts`'s `dayNumber` deliberately rather than importing
 * it: that file lives under `backend/tests/`, colocated with the gate test it
 * exists to make failable, and application code under `backend/src` should
 * not depend on the test tree.
 */
export function dayNumber(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return ms / DAY_MS;
}

/**
 * Every reason this announcement is not ready to send today. Empty means it
 * is safe to send — never "safe to have sent" (there is no undo).
 *
 * `today` is the day the notice would actually go out, supplied by the
 * caller rather than read from the clock in here, so a dry run and the real
 * send evaluate the identical rule.
 */
export function validatePriceChangeAnnouncement(
  announcement: PriceChangeAnnouncement,
  today: string
): string[] {
  const problems: string[] = [];

  if (!announcement.id || !announcement.id.trim()) {
    problems.push(
      'id is required (used as the notice ledger id and the per-recipient marker scope)'
    );
  }
  if (!isPlanId(announcement.planId) || announcement.planId === 'seedling') {
    problems.push(
      `planId must be "garden" or "greenhouse" (seedling has no price to change): got ${String(announcement.planId)}`
    );
  }
  if (announcement.interval !== 'month' && announcement.interval !== 'year') {
    problems.push(`interval must be "month" or "year": got ${String(announcement.interval)}`);
  }
  if (!announcement.summary || announcement.summary.trim().length < 20) {
    problems.push('summary must say what changes and why, in at least 20 characters');
  }
  if (
    typeof announcement.oldPriceUsd !== 'number' ||
    !Number.isFinite(announcement.oldPriceUsd) ||
    announcement.oldPriceUsd < 0
  ) {
    problems.push(
      `oldPriceUsd must be a non-negative number: got ${String(announcement.oldPriceUsd)}`
    );
  }
  if (
    typeof announcement.newPriceUsd !== 'number' ||
    !Number.isFinite(announcement.newPriceUsd) ||
    announcement.newPriceUsd < 0
  ) {
    problems.push(
      `newPriceUsd must be a non-negative number: got ${String(announcement.newPriceUsd)}`
    );
  }
  if (
    typeof announcement.oldPriceUsd === 'number' &&
    typeof announcement.newPriceUsd === 'number' &&
    announcement.oldPriceUsd === announcement.newPriceUsd
  ) {
    problems.push('newPriceUsd equals oldPriceUsd — this is not a price change');
  }

  const todayNum = dayNumber(today);
  if (todayNum === null) problems.push(`today is not a calendar date: ${String(today)}`);

  const effectiveNum = dayNumber(announcement.effectiveOn);
  if (effectiveNum === null) {
    problems.push(
      `effectiveOn must be a real YYYY-MM-DD date: got ${String(announcement.effectiveOn)}`
    );
  } else if (todayNum !== null && effectiveNum - todayNum < MIN_NOTICE_DAYS) {
    problems.push(
      `effectiveOn (${announcement.effectiveOn}) is only ${effectiveNum - todayNum} day(s) after ` +
        `today (${today}); the Terms promise at least ${MIN_NOTICE_DAYS}`
    );
  }

  return problems;
}
