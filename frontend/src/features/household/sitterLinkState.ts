import type { SitterLinkSummary } from '@/services/householdService';

/**
 * What a sitter link can actually do *right now*.
 *
 * `SitterLinkSummary.status` is only the revocation flag — it stays `'active'`
 * for a link whose coverage window has already closed, and for one whose
 * window has not opened yet. The backend never honours either (getActiveLink
 * re-checks `startsAt`/`expiresAt` on every read), but rows survive their own
 * expiry in the management list: the DynamoDB TTL carries a three-day buffer
 * past `expiresAt` and the sweeper itself lags. So for the better part of a
 * week after a trip ends, `status === 'active'` describes a link that grants
 * nothing.
 *
 * Listing those under "Active links" told the household that a neighbour could
 * still see their plants when they could not — and, once links can be
 * scheduled ahead of a trip, the same field would claim a not-yet-open link is
 * live today. This resolves the real state from the window instead.
 */
export type SitterLinkState = 'active' | 'scheduled' | 'expired' | 'revoked';

/**
 * The window fields any time-boxed, revocable grant carries. Sitter links and
 * caretaker seats have the same lifecycle for the same reason (a row outlives
 * its window by the TTL buffer), so they resolve their real state here rather
 * than each guessing from `status`.
 */
export interface TimeBoxedGrant {
  status: 'active' | 'revoked';
  startsAt: string;
  expiresAt: string;
}

export function sitterLinkState(link: TimeBoxedGrant, now: number = Date.now()): SitterLinkState {
  if (link.status === 'revoked') return 'revoked';

  const expiresAt = Date.parse(link.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) return 'expired';

  const startsAt = link.startsAt ? Date.parse(link.startsAt) : Number.NaN;
  if (Number.isFinite(startsAt) && startsAt > now) return 'scheduled';

  // An unparseable window falls through to 'active' on purpose: we cannot
  // prove the link is dead, and the only control that stops it lives on the
  // rows we show. Hiding it would remove the household's ability to revoke it.
  return 'active';
}

export interface SitterLinkGroups {
  /** Links that grant access now, or will once their window opens. */
  current: SitterLinkSummary[];
  /** Windows that have closed on their own — shown as reassurance, not action. */
  ended: SitterLinkSummary[];
}

/**
 * Split the household's links into the ones that still matter and the ones
 * that have quietly ended. Revoked links stay out of both: the household
 * already acted on those, and re-listing them is noise.
 */
export function groupSitterLinks(
  links: SitterLinkSummary[],
  now: number = Date.now()
): SitterLinkGroups {
  const current: SitterLinkSummary[] = [];
  const ended: SitterLinkSummary[] = [];
  for (const link of links) {
    const state = sitterLinkState(link, now);
    if (state === 'active' || state === 'scheduled') current.push(link);
    else if (state === 'expired') ended.push(link);
  }
  return { current, ended };
}
