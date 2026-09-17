/**
 * A logged-out visitor who follows a referral link (`/register?ref=CODE`)
 * has to get through register → confirm-email → household-onboarding before
 * a household exists for the code to apply to. The confirm-email step
 * navigates on router state, not the query string, so `?ref=` would
 * otherwise be dropped on that hop — exactly the problem
 * `features/plants/pendingShareCode.ts` solves for a shared-cutting link,
 * and this is the same fix for the same reason.
 *
 * sessionStorage (not localStorage): the intent is scoped to this tab/visit
 * and never lingers past it. The value is just a referral code (opaque, no
 * PII) and storage access is guarded so SSR/private-mode (where it throws)
 * degrades to "no pending referral" rather than crashing signup.
 */
const KEY = 'fg.pendingReferralCode';

export function setPendingReferralCode(code: string): void {
  try {
    sessionStorage.setItem(KEY, code);
  } catch {
    // Storage unavailable — the referral simply won't be applied
    // automatically; signup itself still works.
  }
}

export function getPendingReferralCode(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingReferralCode(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}
