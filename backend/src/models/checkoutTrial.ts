/**
 * What a new subscription checkout gives before its first charge.
 *
 * Pure: no Stripe, no DynamoDB. `services/billing.ts` applies it to a
 * Checkout Session and publishes it on GET /billing/me, and the no-card-trial
 * emails (`services/trialLifecycleEmailCopy.ts`) use the same constants to
 * name the same first-charge date.
 */

/** Length of the free trial offered on a household's FIRST paid subscription. */
export const TRIAL_PERIOD_DAYS = 14;

/**
 * How long a plan Checkout Session this code creates stays completable.
 *
 * Stripe's default is 24 hours; 30 minutes is the shortest it allows
 * (`expires_at` must fall 30 minutes to 24 hours after creation). It is set
 * to the minimum because a Session that is still open is a Session the
 * household can still pay, so the pending-checkout refusal in services/billing.ts has to hold for at least as
 * long as any Session lives — and the only signal that a household simply
 * closed the Stripe tab is that no signal ever comes. At the 24-hour default
 * the same reasoning would lock a household that abandoned a checkout out of
 * buying for a day.
 */
export const CHECKOUT_SESSION_LIFETIME_SECONDS = 30 * 60;

/**
 * Stripe refuses a Checkout `subscription_data.trial_end` that is less than
 * 48 hours after the Session is created.
 */
export const STRIPE_MIN_TRIAL_END_LEAD_MS = 48 * 60 * 60 * 1000;

/**
 * How far ahead a no-card trial's end must be for a checkout to defer the
 * first charge to it. Stripe's 48 hours, plus the life of the Session: the
 * date is checked when the Session is created, and the buyer may finish it up
 * to `CHECKOUT_SESSION_LIFETIME_SECONDS` later, so the margin keeps the
 * promise "your first charge is on {date}" true for the whole Session.
 */
export const CHECKOUT_TRIAL_END_MIN_LEAD_MS =
  STRIPE_MIN_TRIAL_END_LEAD_MS + CHECKOUT_SESSION_LIFETIME_SECONDS * 1000;

/**
 * What a NEW subscription checkout for this household would give before the
 * first charge (owner decision, 2026-10-23: no stacked trials).
 *
 *   - `card_trial`: the household never had a free trial of any kind, so it
 *     gets `TRIAL_PERIOD_DAYS` with a card on file.
 *   - `until_no_card_trial_end`: the household is on its no-card Garden trial
 *     (ADR 0027) and that trial ends far enough ahead. The subscription's
 *     trial ends when the no-card trial does, so the household adds a card
 *     now and is first charged on that date. It does NOT get 14 more days.
 *   - `none`: charged at checkout. The household already had a card trial
 *     (`trialConsumedAt`), or its no-card trial has ended, or ends within
 *     `CHECKOUT_TRIAL_END_MIN_LEAD_MS`.
 *
 * A `noCardTrialEndsAt` that does not parse is read as absent, the same way
 * `noCardTrialState` in models/plans.ts reads it. Only household creation
 * writes that attribute, always as an ISO date, so the case is a row edited
 * by hand.
 *
 * Pure. `createCheckoutSession` and `getHouseholdSubscription` both call it on
 * the same row, so what Settings → Billing says and what Stripe is asked for
 * cannot drift apart.
 */
export type CheckoutTrial =
  | { kind: 'card_trial'; days: number }
  | { kind: 'until_no_card_trial_end'; endsAt: Date }
  | { kind: 'none' };

export function checkoutTrialFor(
  row: { trialConsumedAt?: string; noCardTrialEndsAt?: string },
  now: Date
): CheckoutTrial {
  if (row.trialConsumedAt) return { kind: 'none' };
  const noCardEnd = row.noCardTrialEndsAt ? Date.parse(row.noCardTrialEndsAt) : NaN;
  if (!Number.isFinite(noCardEnd)) return { kind: 'card_trial', days: TRIAL_PERIOD_DAYS };
  if (noCardEnd - now.getTime() >= CHECKOUT_TRIAL_END_MIN_LEAD_MS) {
    return { kind: 'until_no_card_trial_end', endsAt: new Date(noCardEnd) };
  }
  return { kind: 'none' };
}
