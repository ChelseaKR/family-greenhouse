import { api } from './api';
import type { PlanId } from './billingService';

/**
 * Refer-a-friend (ADR 0029): GET /me/referral, the caller's own shareable
 * code plus their referral history — the data behind the "Refer a friend"
 * settings panel.
 *
 * Distinct from `householdService`'s invite flow on purpose: an invite adds
 * someone to YOUR household (`POST /households/:id/invites`); a referral is
 * carried as `?ref=CODE` into `/register`, stashed across the signup hops
 * (`features/referrals/pendingReferralCode.ts`, mirroring
 * `features/plants/pendingShareCode.ts`), and applied server-side as an
 * optional field on `POST /households` (`householdService.createHousehold`
 * -> `services/referrals.ts`) — never a separate "redeem" call, because by
 * the time a referred signup could call one, their OWN household already
 * exists and already carries the bonus or doesn't.
 */
export interface ReferralEntry {
  signedUpAt: string;
  /** Whether the REFERRER'S side of the bonus was granted for this signup.
   *  The new household's own bonus, if any, is never false — an ungranted
   *  new-household bonus is never recorded as a referral at all (see
   *  services/referrals.ts's `creditReferralAfterSignup`). */
  rewarded: boolean;
}

export interface ReferralStatus {
  /** Display form, `RF-XXXXX-XXXXX`. */
  code: string;
  bonusPlanId: Exclude<PlanId, 'seedling'>;
  bonusMonths: number;
  totalReferrals: number;
  grantedReferrals: number;
  referrals: ReferralEntry[];
}

export const referralService = {
  async getMyReferral(): Promise<ReferralStatus> {
    const response = await api.get<ReferralStatus>('/me/referral');
    return response.data;
  },
};

/** `https://<origin>/register?ref=<code>` — built client-side so the API
 *  never has to know its own public origin. */
export function referralLink(code: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/register?ref=${encodeURIComponent(code)}`;
}
