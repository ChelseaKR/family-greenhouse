/**
 * A logged-out visitor who lands on a public cutting card and taps "Grow your
 * own cutting" has to sign up before they can graft it into a greenhouse. The
 * register → confirm-email → onboarding flow drops URL params (the
 * confirm-email step navigates on router state, not the query string), so we
 * stash the share code in sessionStorage to carry it across those hops.
 *
 * sessionStorage (not localStorage) so the intent is scoped to this tab/visit
 * and never lingers: once the new member finishes household setup we redeem it
 * and clear it. The value is just a share code (opaque, no PII), and access is
 * guarded so SSR/privacy-mode (where storage throws) degrades to "no pending
 * graft" rather than crashing the signup flow.
 */
const KEY = 'fg.pendingShareCode';

export function setPendingShareCode(code: string): void {
  try {
    sessionStorage.setItem(KEY, code);
  } catch {
    // Storage unavailable (private mode / SSR) — the graft simply won't be
    // resumed automatically; the card itself still works.
  }
}

export function getPendingShareCode(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingShareCode(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}
