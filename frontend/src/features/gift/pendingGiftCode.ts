/**
 * A gift code carried from a `/redeem#FG-…` link through sign-up, email
 * confirmation, sign-in and household creation, so the recipient does not
 * have to find the code again once a household exists to redeem it on.
 *
 * Same shape and reasoning as `features/referrals/pendingReferralCode.ts`:
 * sessionStorage, so it is scoped to this tab and never outlives the visit,
 * and every access is guarded, because private modes and blocked site data
 * throw. When storage is unavailable `setPendingGiftCode` says so, and the
 * /redeem page tells the visitor to paste the code after signing in instead.
 *
 * The code is a bearer credential. It arrives in the URL FRAGMENT, which the
 * browser never sends to the server, CloudFront logs or analytics; this module
 * is the only place it is kept, and it is cleared on redemption.
 */
import { normalizeGiftCodeInput } from './giftLink';

const KEY = 'fg.pendingGiftCode';

/** Store a code. Returns false when storage is unavailable or the code is malformed. */
export function setPendingGiftCode(code: string): boolean {
  const normalized = normalizeGiftCodeInput(code);
  if (!normalized) return false;
  try {
    sessionStorage.setItem(KEY, normalized);
    return sessionStorage.getItem(KEY) === normalized;
  } catch {
    return false;
  }
}

export function getPendingGiftCode(): string | null {
  try {
    return normalizeGiftCodeInput(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function clearPendingGiftCode(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}
