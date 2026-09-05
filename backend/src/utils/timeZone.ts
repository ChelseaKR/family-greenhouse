/**
 * IANA timezone validation, with no I/O and no AWS imports.
 *
 * This lived in `services/notificationPrefs.ts`, which is where the product's
 * only timezone came from: a per-user zone used by the quiet-hours check and
 * the reminder dedupe key. `notificationPrefs.ts` reaches DynamoDB and SMS, so
 * anything wanting to validate a zone had to import that whole module — fine
 * for a handler, wrong for a pure rule module that `householdService` calls on
 * the read path (the import-cycle reason `services/escalationRule.ts` gives
 * for existing at all).
 *
 * Moved here rather than copied. Two implementations of "is this a real zone"
 * is exactly the drift this repo keeps unwinding, and the accepted set is not
 * obvious enough to re-derive: `Intl.supportedValuesOf` omits accepted link
 * names, so the fallback below is load-bearing rather than defensive padding.
 * `notificationPrefs.ts` re-exports this symbol, so every existing caller —
 * `handlers/notifications/handler.ts`, `services/billingEmails.ts` — is
 * unchanged.
 */

/** Memoised because `Intl.supportedValuesOf` builds a ~600-entry array. */
let supportedTimeZones: Set<string> | null = null;

/**
 * Validate an IANA timezone. Primary check is the runtime's canonical list
 * (`Intl.supportedValuesOf`); we fall back to letting Intl resolve the name
 * because `supportedValuesOf` omits some accepted aliases (e.g. links like
 * "Etc/GMT" variants).
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    if (!supportedTimeZones) {
      supportedTimeZones = new Set(Intl.supportedValuesOf('timeZone'));
    }
    if (supportedTimeZones.has(tz)) return true;
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
