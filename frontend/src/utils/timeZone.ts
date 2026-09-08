/**
 * IANA timezone helpers for the browser.
 *
 * `resolveBrowserTimeZone` lived as a private function inside
 * `features/settings/NotificationSettings.tsx`, which was the only surface that
 * needed it while the only zone in the product was the per-member one used for
 * quiet hours. ADR 0025 adds a second, household-wide zone with its own card,
 * so it is moved here rather than copied — two implementations of "what zone is
 * this browser in" is exactly the drift the backend unwound when
 * `isValidTimeZone` moved to `backend/src/utils/timeZone.ts`.
 *
 * This module imports nothing. It is a leaf, deliberately: a value imported
 * into a widely-imported module is how a runtime import cycle gets built that
 * `tsc --noEmit` cannot see.
 */

/**
 * The IANA zone this browser reports, or `null` when it cannot be resolved —
 * no `Intl`, a runtime that throws, or one that answers with a placeholder.
 *
 * `null` means "we do not know", and every caller has to treat it as its own
 * state. It is never a guessed zone and never `'UTC'`: choosing UTC is a
 * choice, and a browser that cannot name its zone has not made one.
 */
export function resolveBrowserTimeZone(): string | null {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== 'string' || zone.trim() === '' || zone === 'Etc/Unknown') return null;
    return zone;
  } catch {
    return null;
  }
}

/**
 * Whether the runtime accepts `zone` as an IANA name.
 *
 * The same two-step rule the backend uses: the canonical list first, then a
 * constructor attempt, because `Intl.supportedValuesOf` omits accepted link
 * names (`Etc/GMT` variants, `US/Pacific`) and rejecting those would refuse a
 * zone the server then accepts. Client-side validation here is a courtesy —
 * the server validates again and is the authority — so it must not be
 * *stricter* than the server, or the form refuses input the API would take.
 *
 * A runtime with no `Intl.supportedValuesOf` (older Safari) falls through to
 * the constructor, which is why the list lookup is not the only check.
 */
let supportedTimeZones: Set<string> | null = null;

export function isValidTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    if (!supportedTimeZones && typeof Intl.supportedValuesOf === 'function') {
      supportedTimeZones = new Set(Intl.supportedValuesOf('timeZone'));
    }
    if (supportedTimeZones?.has(zone)) return true;
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Test seam: `Intl.supportedValuesOf` is memoised, and a test may change it. */
export function resetTimeZoneCacheForTests(): void {
  supportedTimeZones = null;
}
