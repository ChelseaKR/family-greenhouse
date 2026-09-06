/**
 * Decision logic for the post-signup first run, kept free of React so the
 * rules can be tested directly.
 *
 * The first run is the only moment we get to show someone what this app is
 * for, so the gate has to be right in three directions: never withhold it
 * from someone who has just created a household, never withhold it from
 * someone who has just JOINED one, and never re-run it for a person who has
 * already been shown it.
 *
 * `welcomeSeen` alone cannot carry that, because it lives in per-device
 * localStorage. So the gate corroborates it with household facts.
 *
 * The plant count answers "has this HOUSEHOLD started?". It used to answer
 * both questions at once — `plantCount > 0` meant "established, skip" — and
 * that is what made the second person in a household invisible to the first
 * run. A household worth joining already has plants in it, so every single
 * joiner took the skip branch and landed on a dashboard of someone else's
 * plants, having been asked for nothing. "This household has started" and
 * "this person is new to it" are different facts and are now read from
 * different places: the plant count, and the caller's own membership age.
 *
 * A household with plants therefore still welcomes a new member; it just says
 * something different to them than "add your first plant" (see
 * `FirstRunVariant`).
 *
 * Both household facts are deliberately `number | null` rather than a
 * coalesced `?? 0`. An unread or failed call is NOT the number zero — treating
 * it as one would drop an established household back into "add your first
 * plant" on a transient 500, and would read an unreadable join date as
 * "joined just now" (ADR 0010 / the absence-as-value class). A failed read
 * therefore leaves the first run alone entirely: we send the user to the
 * dashboard WITHOUT marking the tour seen, so the next successful load can
 * still decide properly. That applies to the membership read too — burning
 * `welcomeSeen` on a read we could not make would spend this person's one
 * chance at a first run on a network error.
 */

/** Ordered first-run steps. `invite` only applies to household admins. */
export const FIRST_RUN_STEPS = ['plant', 'invite'] as const;

export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

/**
 * Which first run this is.
 *
 * - `founder` — the household has no plants. "Add your first plant" is true.
 * - `joiner`  — the household has plants and this person is new to it. The
 *   steps are the same and the endpoints are the same; the copy is not,
 *   because they are not starting a greenhouse, they are joining one.
 */
export type FirstRunVariant = 'founder' | 'joiner';

export type FirstRunDecision =
  /** The household facts have not settled yet — render a loading state. */
  | { kind: 'loading' }
  /** Don't run: navigate away, optionally recording that it's been handled. */
  | { kind: 'leave'; to: string; markSeen: boolean }
  /** Run the first run, in the variant the facts call for. */
  | { kind: 'run'; variant: FirstRunVariant };

/**
 * How recently someone must have joined for the first run to still be theirs
 * to see.
 *
 * This is a judgement, and it is the one number in this file that is not a
 * fact about the world. A joiner normally lands here within seconds of
 * accepting the invite (invite-acceptance navigates to `/`), but someone who
 * accepts on a phone at the airport and opens the app properly the next
 * evening is still a new member and still deserves the welcome. A week is
 * long enough to cover that and short enough that a member of eight months
 * signing in on a new laptop is never treated as new.
 *
 * The cost of being wrong in either direction is deliberately asymmetric: too
 * long shows an established member one skippable screen, too short returns us
 * to the defect this file exists to fix.
 */
export const NEW_MEMBER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  /**
   * How long this user has been a member of the ACTIVE household, in
   * milliseconds, or `null` while the read is unsettled. Never pass `0` for
   * "we don't know" — zero here means "joined this instant", which is the
   * strongest possible claim that someone is new.
   */
  membershipAgeMs: number | null;
  /**
   * True when the membership read settled without a usable join date: the
   * request failed, the active household was not in the returned list, or
   * `joinedAt` did not parse. All three mean the same thing — we cannot tell
   * whether this person is new — and none of them is an answer.
   */
  membershipUnknown: boolean;
}

export function decideFirstRun({
  hasHousehold,
  welcomeSeen,
  plantCount,
  plantsFailed,
  membershipAgeMs,
  membershipUnknown,
}: FirstRunInputs): FirstRunDecision {
  // No household yet: household setup owns this user, not the first run.
  if (!hasHousehold) return { kind: 'leave', to: '/onboarding', markSeen: false };

  if (welcomeSeen) return { kind: 'leave', to: '/dashboard', markSeen: false };

  // A failed read is not an empty household. Step aside without recording
  // anything so a later successful load can still make the call.
  if (plantsFailed) return { kind: 'leave', to: '/dashboard', markSeen: false };

  if (plantCount === null) return { kind: 'loading' };

  // Nothing in the household yet, so nobody can be joining an established
  // one. Answered without waiting on the membership read: the founder's path
  // is the latency-sensitive one and it needs no second fact.
  if (plantCount === 0) return { kind: 'run', variant: 'founder' };

  // The HOUSEHOLD has started. Whether this PERSON has is a different
  // question, and an unanswered one is not a "yes".
  if (membershipUnknown) return { kind: 'leave', to: '/dashboard', markSeen: false };

  if (membershipAgeMs === null) return { kind: 'loading' };

  // Negative ages come from clock skew between the server's `joinedAt` and
  // this browser; "joined in the future" is as new as it gets.
  if (membershipAgeMs <= NEW_MEMBER_WINDOW_MS) return { kind: 'run', variant: 'joiner' };

  // An established household and an established member: a returning user on
  // a new device. This is the case the plant-count rule was written for.
  return { kind: 'leave', to: '/dashboard', markSeen: true };
}

/**
 * The steps this particular user gets. Creating an invite is admin-only
 * server-side (`requireAdmin` on POST /households/:id/invites), so offering
 * it to a plain member would be a button that 403s.
 */
export function firstRunStepsFor(canInvite: boolean): FirstRunStep[] {
  return canInvite ? ['plant', 'invite'] : ['plant'];
}
