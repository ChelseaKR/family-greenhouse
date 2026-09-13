import type { SubscriptionState } from '@/services/billingService';

/**
 * Which no-card Garden trial notice (ADR 0027) a placement shows, if any. Kept
 * apart from the component so the rule is importable and testable on its own.
 * See `NoCardTrialNotice.tsx` for what each notice says.
 */

export const NO_CARD_TRIAL_ENDING_SOON_DAYS = 3;
export const NO_CARD_TRIAL_ENDED_DASHBOARD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type NoCardTrialNoticeKind = 'started' | 'endingSoon' | 'ended';
export type NoCardTrialPlacement = 'dashboard' | 'billing';

export function noCardTrialNoticeKind(
  subscription: SubscriptionState | null | undefined,
  placement: NoCardTrialPlacement,
  now: Date = new Date()
): NoCardTrialNoticeKind | null {
  const trial = subscription?.noCardTrial;
  if (!trial) return null;
  const endsAt = Date.parse(trial.endsAt);
  if (!Number.isFinite(endsAt)) return null;
  if (trial.state === 'active') {
    return endsAt - now.getTime() <= NO_CARD_TRIAL_ENDING_SOON_DAYS * DAY_MS
      ? 'endingSoon'
      : 'started';
  }
  if (
    placement === 'dashboard' &&
    now.getTime() - endsAt > NO_CARD_TRIAL_ENDED_DASHBOARD_DAYS * DAY_MS
  ) {
    return null;
  }
  return 'ended';
}
