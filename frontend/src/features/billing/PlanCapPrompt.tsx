import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LockedFeature } from '@/components/LockedFeature';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { billingService } from '@/services/billingService';
import { capReached, type HouseholdCap } from './planCaps';

interface PlanCapPromptProps {
  cap: HouseholdCap;
  className?: string;
}

/**
 * The upgrade prompt at a household cap: shown BEFORE the person fills in a
 * form the server would refuse, not after.
 *
 * It says three true things, in this order: how many the household has and
 * how many its plan holds (the caps the server enforces for this household,
 * so a grandfathered one is never told it is full early); that nothing it has
 * is removed or locked; and what would make room, a free way first. The
 * price, the plan that lifts the cap, the admin's "Change plan" button (the
 * existing checkout in Settings → Billing) and a member's one-tap ask all come
 * from `LockedFeature`, which already withholds the price and the purchase
 * call inside the native apps (Guideline 3.1.1).
 *
 * Renders nothing unless the cap is known to be reached (`capReached`).
 */
export function PlanCapPrompt({ cap, className }: PlanCapPromptProps) {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  // Keyed exactly as LockedFeature keys it, so the card inside costs no
  // second request.
  const subQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: !!householdId,
    staleTime: 60_000,
  });

  const reached = capReached(subQuery.data, cap);
  if (!reached) return null;

  return (
    <div data-testid={`plan-cap-prompt-${cap}`} className={className}>
      <LockedFeature
        feature={cap === 'plants' ? 'plant_cap' : 'member_cap'}
        title={t(`planCap.${cap}.title`)}
      >
        {t(`planCap.${cap}.body`, { n: reached.count, max: reached.max })}
      </LockedFeature>
    </div>
  );
}
