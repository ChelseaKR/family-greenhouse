/**
 * The free/paid line for sitter links (ADR 0015), as a pure check shared by
 * the Lambda handler and the local dev server.
 *
 * Seedling keeps ONE live link of up to seven days — the task list for a
 * weekend away, complete and free. Garden and Greenhouse get windows up to
 * 90 days and several live links at once (the Away Kit). The numbers live on
 * the plan catalog (`models/plans.ts` → `limits`); this module only turns
 * them into a decision and a sentence the creator can act on.
 *
 * Why 402 and not 400: the request is well-formed; what it lacks is
 * entitlement. That is the same code the plant cap uses, so the client's
 * upgrade prompt already knows how to read it.
 */
import { PLANS, type Plan } from '../models/plans.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tolerance for clock skew between the client's "now" and ours. */
const SKEW_MS = 60 * 1000;

/** Coverage window length in whole-day terms (fractional days allowed). */
export function sitterWindowDays(startsAt: string, expiresAt: string): number {
  return (Date.parse(expiresAt) - Date.parse(startsAt)) / DAY_MS;
}

/** Links that still grant, or will grant, access: active and not yet ended. */
export function countLiveSitterLinks(
  links: ReadonlyArray<{ status: string; expiresAt: string }>,
  now: Date = new Date()
): number {
  const nowIso = now.toISOString();
  return links.filter((l) => l.status === 'active' && l.expiresAt > nowIso).length;
}

export type SitterPlanGateResult = { ok: true } | { ok: false; message: string };

/**
 * Decide whether a household on `plan` may create a link of `windowDays`
 * while `liveLinks` are already live. The message names the cap that was hit
 * and, on the free tier, what Garden lifts it to — so the sentence the
 * traveller reads at the moment of need is the upgrade prompt.
 */
export function checkSitterLinkPlanGate(
  plan: Plan,
  input: { windowDays: number; liveLinks: number }
): SitterPlanGateResult {
  const { sitterLinkMaxDays, sitterLinksActive } = plan.limits;
  const garden = PLANS.garden;
  const onFree = plan.id === 'seedling';

  if (input.windowDays > sitterLinkMaxDays + SKEW_MS / DAY_MS) {
    const lift = onFree
      ? ` ${garden.name} allows up to ${garden.limits.sitterLinkMaxDays} days.`
      : ' Shorten the window.';
    return {
      ok: false,
      message: `Your ${plan.name} plan allows sitter links of up to ${sitterLinkMaxDays} days.${lift}`,
    };
  }

  if (input.liveLinks >= sitterLinksActive) {
    const noun = sitterLinksActive === 1 ? 'sitter link' : 'sitter links';
    const lift = onFree ? `, or upgrade to ${garden.name} for several at once` : '';
    return {
      ok: false,
      message: `Your ${plan.name} plan allows ${sitterLinksActive} live ${noun} at a time. Revoke one to create another${lift}.`,
    };
  }

  return { ok: true };
}
