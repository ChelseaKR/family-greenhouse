/**
 * App-store age assurance: the one place Family Greenhouse's policy is set.
 *
 * Background: _agent-tools/growth/age-assurance-compliance-2026-10-30.md
 * (Texas SB 2420, California AB 1043, Alabama HB 161, Utah 13-76, Louisiana
 * R.S. 51:1771). Apple does age verification, parental consent and Ask to
 * Buy; the app's part is to ask for the age range, use it only to comply,
 * and keep it in memory only. Each value below is one of the report's
 * section 7 options; the defaults are its recommendations, and changing a
 * decision means changing a value here, not code elsewhere.
 */

/** When the iPhone app asks Apple for the age range (decision D). */
export type AgeRangeRequestPolicy =
  /** D1: only when Apple says a law covers the person. Recommended. */
  | 'onlyWhenRequired'
  /** D2: on every launch, for everyone on iOS 26.2 or later. */
  | 'always';

/** Who may hold an account (decision A). */
export type AccountAgePolicy =
  /** A1: refuse sign-up, sign-in and invitations when the store says under 13. Recommended. */
  | 'blockUnder13'
  /** A2: refuse them when the store says under 18. */
  | 'blockUnder18';

/** Who may start a paid plan (decision B). */
export type PaidPlanPolicy =
  /** B1: the Terms say the payer must be an adult; Ask to Buy covers Apple. Recommended. */
  | 'termsOnly'
  /** B2: also refuse checkout in the app when the store says under 18. */
  | 'blockMinorCheckout';

export interface AgeAssurancePolicy {
  requestPolicy: AgeRangeRequestPolicy;
  accounts: AccountAgePolicy;
  paidPlans: PaidPlanPolicy;
}

export const AGE_ASSURANCE_POLICY: AgeAssurancePolicy = {
  requestPolicy: 'onlyWhenRequired',
  accounts: 'blockUnder13',
  paidPlans: 'termsOnly',
};
