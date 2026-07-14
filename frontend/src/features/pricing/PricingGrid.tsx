import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';

/**
 * Public plan-status surface. Pricing, interval selectors, purchase links, and
 * registration CTAs are intentionally absent while the repository-level
 * commercial hold is active. Reactivation requires restoring a reviewed UI in
 * addition to changing the shared status and backend deployment controls.
 */
export function PricingGrid() {
  if (!COMMERCIAL_HOLD_ACTIVE) {
    return null;
  }

  return <CommercialHoldNotice className="mx-auto mt-10 max-w-2xl" />;
}
