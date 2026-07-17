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
 * revenue, so it emits the confirmed counterpart `subscription_activated`.
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
export type ServerEventName = 'subscription_activated'; // Stripe webhook confirmed a paid plan is active.

export interface ServerEventProps {
  /** Plan the household activated. */
  plan?: 'garden' | 'greenhouse';
  /** Billing cadence stamped on the Stripe metadata at checkout. `lifetime`
   *  is the one-time Garden purchase. */
  interval?: 'month' | 'year' | 'lifetime';
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
