/**
 * Decision logic for the post-signup first run, kept free of React so the
 * rules can be tested directly.
 *
 * The first run is the only moment we get to show a new household what this
 * app is for, so the gate has to be right in both directions: never withhold
 * it from someone who has just created a household, and never re-run it for
 * an established one (a returning user on a new device, or someone who joined
 * a household that already has plants — telling them to "add your first
 * plant" would be wrong).
 *
 * `welcomeSeen` alone cannot carry that, because it lives in per-device
 * localStorage. So the gate corroborates it with a household fact: a
 * household with plants in it has already started, whatever this browser
 * remembers.
 *
 * The plant count is deliberately `number | null` rather than a coalesced
 * `?? 0`. An unread or failed plants call is NOT the number zero — treating
 * it as one would drop an established household back into "add your first
 * plant" on a transient 500 (ADR 0010 / the absence-as-value class). A failed
 * read therefore leaves the first run alone entirely: we send the user to the
 * dashboard WITHOUT marking the tour seen, so the next successful load can
 * still decide properly.
 */

/** Ordered first-run steps. `invite` only applies to household admins. */
export const FIRST_RUN_STEPS = ['plant', 'invite'] as const;

export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

export type FirstRunDecision =
  /** The household facts have not settled yet — render a loading state. */
  | { kind: 'loading' }
  /** Don't run: navigate away, optionally recording that it's been handled. */
  | { kind: 'leave'; to: string; markSeen: boolean }
  /** Brand-new household: run the first run. */
  | { kind: 'run' };

export interface FirstRunInputs {
  /** Whether the user belongs to a household yet. */
  hasHousehold: boolean;
  /** Per-device flag: has this browser already shown the first run? */
  welcomeSeen: boolean;
  /**
   * Active plants in the household, or `null` while the read is unsettled.
   * Never pass `0` for "we don't know".
   */
  plantCount: number | null;
  /** True when the plants read settled in failure. */
  plantsFailed: boolean;
}

export function decideFirstRun({
  hasHousehold,
  welcomeSeen,
  plantCount,
  plantsFailed,
}: FirstRunInputs): FirstRunDecision {
  // No household yet: household setup owns this user, not the first run.
  if (!hasHousehold) return { kind: 'leave', to: '/onboarding', markSeen: false };

  if (welcomeSeen) return { kind: 'leave', to: '/dashboard', markSeen: false };

  // A failed read is not an empty household. Step aside without recording
  // anything so a later successful load can still make the call.
  if (plantsFailed) return { kind: 'leave', to: '/dashboard', markSeen: false };

  if (plantCount === null) return { kind: 'loading' };

  // The household is already under way — this is not someone's first minute.
  if (plantCount > 0) return { kind: 'leave', to: '/dashboard', markSeen: true };

  return { kind: 'run' };
}

/**
 * The steps this particular user gets. Creating an invite is admin-only
 * server-side (`requireAdmin` on POST /households/:id/invites), so offering
 * it to a plain member would be a button that 403s.
 */
export function firstRunStepsFor(canInvite: boolean): FirstRunStep[] {
  return canInvite ? ['plant', 'invite'] : ['plant'];
}
