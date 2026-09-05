/**
 * Server-side analytics shim. Records typed product events in first-party
 * structured logs and can post them to PostHog's `/capture/` endpoint
 * directly — no SDK, mirroring the frontend shim.
 *
 * Every call writes a typed, first-party CloudWatch product event. Optional
 * PostHog fan-out activates when `POSTHOG_KEY` (a SERVER/project API key) is
 * set; `POSTHOG_HOST` defaults to https://us.i.posthog.com.
 *
 * This emitter exists to fire CONFIRMED revenue events from the trusted
 * backend. The frontend `subscription_upgraded` event fires at checkout START
 * (intent, not confirmation); the Stripe webhook is the source of truth for
 * revenue, so it emits the confirmed counterparts.
 *
 * The three server events form the subscription lifecycle, and only the
 * middle one is money:
 *
 *   subscription_activated  → a 14-day TRIAL began (or a lifetime purchase
 *                             completed — the one case where it is always
 *                             revenue).
 *   subscription_paid       → the subscription became `active`, which Stripe
 *                             only does once an invoice has actually been
 *                             paid. This is the paid conversion.
 *   subscription_deactivated→ the subscription was deleted at Stripe. Churn.
 *
 * Do not read `subscription_activated` as revenue for recurring plans: a
 * household's FIRST subscription checkout carries `trial_period_days: 14`, so
 * no money has moved when it fires. It is not a reliable "no money yet" marker
 * either — the trial is once per household (`trialConsumedAt`), so a household
 * that resubscribes gets no trial days and IS charged at checkout. Neither
 * direction can be inferred from this event alone; `subscription_paid` is the
 * one that means money. See docs/analytics.md and the caveat at the emit site
 * in `services/billing.ts`.
 *
 * Privacy / safety:
 *  - distinct_id is a stable household-scoped id (`household:<householdId>`)
 *    and we attach `$groups: { household: <householdId> }`. We never send
 *    email, names, plant names, or any free text.
 *  - Event properties are limited to enum-like discriminators (plan id,
 *    billing interval) — never user-supplied strings.
 *  - The trusted server conversion is operational telemetry rather than
 *    browser tracking, so it has no browser Do-Not-Track signal to honor.
 *    Only the optional PostHog fan-out is key-gated.
 *  - `capture()` NEVER throws to its caller (wrapped in try/catch). Analytics
 *    failures must not affect the webhook — a thrown error there would 5xx and
 *    make Stripe retry a delivery that actually succeeded.
 */

import { logger } from './logger.js';

const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

/** Server-side product events emitted from trusted backend paths. */
export type ServerEventName =
  // Checkout completed. For a recurring plan this is a TRIAL START — no money
  // has moved. For `interval: 'lifetime'` it is a completed one-time payment.
  | 'subscription_activated'
  // The subscription reached Stripe status `active` from a non-active status.
  // Stripe only makes that transition after an invoice is actually paid, so
  // this is the money-moved signal. `from: 'trialing'` is a trial conversion.
  | 'subscription_paid'
  // `customer.subscription.deleted` — the subscription is gone at Stripe.
  | 'subscription_deactivated';

export interface ServerEventProps {
  /** Plan the household activated, paid for, or churned out of. */
  plan?: 'garden' | 'greenhouse';
  /** Billing cadence stamped on the Stripe metadata at checkout. `lifetime`
   *  is the one-time Garden purchase. */
  interval?: 'month' | 'year' | 'lifetime';
  /**
   * `subscription_paid` only — the Stripe status the subscription held
   * immediately before it became `active`. `trialing` is a trial converting to
   * paid (the number the business cares about); `past_due`/`unpaid`/
   * `incomplete` is a recovered payment, which is real revenue but NOT a new
   * conversion. Count them separately. Bucketed to a closed enum so an
   * unfamiliar Stripe status can never become free text in the log stream.
   */
  from?: 'trialing' | 'past_due' | 'unpaid' | 'incomplete' | 'paused' | 'other';
  /**
   * `subscription_deactivated` only — Stripe's `cancellation_details.reason`,
   * bucketed. Distinguishes voluntary churn (`requested`) from involuntary
   * churn (`payment_failed`), which have completely different remedies.
   * Absent when Stripe did not record a reason.
   */
  churnReason?: 'requested' | 'payment_failed' | 'payment_disputed' | 'other';
}

/**
 * Best-effort capture. The first-party event is always logged for a valid
 * household. Optional PostHog fan-out resolves (never rejects) regardless of
 * outcome and no-ops without a key. Callers in critical paths can
 * `void`-ignore this safely.
 */
export async function capture(
  householdId: string,
  event: ServerEventName,
  properties: ServerEventProps = {}
): Promise<void> {
  if (!householdId) return;

  logger.info(
    {
      msg: 'product_event',
      productEvent: event,
      properties,
      householdId,
      source: 'stripe_webhook',
    },
    'product_event'
  );

  // Read the key at call time (not module load) so tests can toggle it and
  // so a redeploy that sets it takes effect without a cold-start dependency.
  const key = process.env.POSTHOG_KEY;
  if (!key) return;
  try {
    await fetch(`${HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: `household:${householdId}`,
        properties: {
          ...properties,
          $groups: { household: householdId },
          $lib: 'family-greenhouse-server-shim',
          $lib_version: '1.0.0',
        },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Never throw to the caller — analytics failures must not affect billing.
  }
}
