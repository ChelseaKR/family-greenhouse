/**
 * The household's IANA timezone — the PURE half. No I/O and no AWS imports,
 * so `householdService.getHousehold` can normalise the stored value on the
 * read path without an import cycle (the same reason `escalationRule.ts`
 * exists next to `escalation.ts`).
 *
 * ## Nothing reads this for due-date math yet, and that is deliberate
 *
 * Issue #342 is the root cause behind #346, #542 and #343: a task's due date
 * is stored as a full ISO instant and every overdue / window / digest / ICS
 * comparison is an instant comparison in the Lambda's zone, which is UTC.
 * Watering is a calendar day, not a moment. Fixing that means reinterpreting
 * `nextDue` for every task already in production, which reclassifies live
 * households' tasks on the day it ships. That is an owner decision, and the
 * plan for it is [ADR 0025](../../../docs/adr/0025-household-timezone-and-the-due-date-migration.md).
 *
 * This module is the part that can land ahead of that decision without
 * changing a single existing answer: the zone is stored, validated and
 * readable, and no caller consults it. Additive and unused, on purpose.
 *
 * ## Why `''` and not `'UTC'`
 *
 * `NotificationPreferences.timezone` defaults to `'UTC'`, and #342's own
 * write-up names the cost: `'UTC'` reads the same for a household that
 * genuinely chose UTC and for one that has never been asked, so quiet hours
 * were evaluated in the wrong zone with nothing able to tell the two apart.
 * `emailLocale` already solved this in the same file with an explicit `''`
 * sentinel, and ADR 0010 is the general rule — a settled read with no data is
 * its own state, not an empty one.
 *
 * The distinction is load-bearing for the migration, not decoration. ADR 0025
 * treats "no zone set" as a household that must keep the behaviour it has
 * today; a household that has chosen UTC gets the new calendar-day rule
 * evaluated in UTC, which is not the same code path even though the offset is
 * identical. Collapsing them now would destroy the only signal the cutover has.
 */
import { isValidTimeZone } from '../utils/timeZone.js';

export { isValidTimeZone };

/**
 * "This household has never set a zone." Distinct from `'UTC'`, which is a
 * choice. See the module header.
 */
export const HOUSEHOLD_TIMEZONE_UNSET = '';

/**
 * Read-side normalisation of the stored zone.
 *
 * Anything that is not a currently-valid IANA name reads as unset: absent
 * (every household today), the wrong type, an empty string, or a name the
 * runtime's tz database no longer resolves. The last case is the reason this
 * validates on READ as well as on write — zone names are retired upstream, so
 * a value that was valid when saved can stop being valid without anyone
 * touching the row, and `Intl` throws on the bad name rather than returning
 * something falsy. `isInDndWindow` already had to catch that exception at use
 * time; normalising here means the due-date math ADR 0025 describes never has
 * to.
 *
 * Failing to unset, rather than to `'UTC'`, is the conservative direction: it
 * means "we do not know this household's zone", which ADR 0025 maps to
 * today's behaviour, instead of asserting a zone nobody picked.
 */
export function normalizeHouseholdTimeZone(raw: unknown): string {
  if (typeof raw !== 'string') return HOUSEHOLD_TIMEZONE_UNSET;
  if (raw === '') return HOUSEHOLD_TIMEZONE_UNSET;
  if (!isValidTimeZone(raw)) return HOUSEHOLD_TIMEZONE_UNSET;
  return raw;
}

/** Whether a household has an explicitly chosen zone. */
export function hasHouseholdTimeZone(raw: unknown): boolean {
  return normalizeHouseholdTimeZone(raw) !== HOUSEHOLD_TIMEZONE_UNSET;
}
