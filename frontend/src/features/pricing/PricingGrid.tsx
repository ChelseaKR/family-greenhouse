import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';

/**
 * Public plan-status surface. Pricing, interval selectors, purchase links, and
 * paid-plan CTAs are intentionally absent while the repository-level
 * commercial hold is active. Free-registration controls live in the parent
 * page and are governed by their separate fail-closed status flag.
 */
export function PricingGrid() {
  if (!COMMERCIAL_HOLD_ACTIVE) {
    return null;
  }

  return <CommercialHoldNotice className="mx-auto mt-10 max-w-2xl" />;
}
