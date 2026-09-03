import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';
import { buttonStyles } from '@/components/buttonStyles';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { billingService } from '@/services/billingService';
import { PaidPlanGrid } from './PaidPlanGrid';

/**
 * Public plan surface.
 *
 * While the repository-level commercial hold is active this renders the status
 * notice and nothing else — no amounts, no interval controls, no purchase
 * paths. Once the hold lifts it renders the catalog returned by the API, which
 * is itself the authority on whether amounts may be shown at all: the server
 * withholds every price field until both commercial gates are open, so a
 * frontend deployed ahead of the backend degrades to the notice rather than
 * advertising a price the API will not honour.
 *
 * Purchases never start here. This surface is unauthenticated, and the API
 * requires an authenticated household admin, so the call to action sends
 * visitors to registration and the real purchase path lives in
 * Settings -> Billing.
 */
export function PricingGrid({ publishedFooter }: PricingGridProps = {}) {
  // The catalog query lives in the child, not here, so that the held surface
  // mounts no data-fetching hook at all: while the hold is on this page is
  // pure static copy and needs no query client in the tree.
  if (COMMERCIAL_HOLD_ACTIVE) {
    return <CommercialHoldNotice className="mx-auto mt-10 max-w-2xl" />;
  }
  return <PublishedPlanCatalog publishedFooter={publishedFooter} />;
}

interface PricingGridProps {
  /**
   * Rendered directly beneath the grid, but ONLY when real amounts are on
   * screen. Callers use it for copy that describes the terms of a purchase
   * (trial, card collection, where checkout happens). That copy contradicts
   * the fail-closed notice, so it must never survive the fallback — this is
   * the same defect the landing page's plans band had, and the slot exists so
   * a caller cannot reintroduce it.
   */
  publishedFooter?: React.ReactNode;
}

function PublishedPlanCatalog({ publishedFooter }: PricingGridProps) {
  const { t } = useTranslation();
  const plansQuery = useQuery({
    queryKey: ['plans'],
    queryFn: billingService.listPlans,
  });

  if (plansQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Fail closed on a missing or malformed catalog, and on a backend that still
  // reports payment activity as unavailable.
  if (!plansQuery.data || plansQuery.data.paymentsAvailable !== true) {
    return <CommercialHoldNotice className="mx-auto mt-10 max-w-2xl" />;
  }

  return (
    <>
      <PaidPlanGrid
        plans={plansQuery.data.plans}
        renderCta={(plan) => (
          <Link
            to="/register"
            className={buttonStyles({
              variant: plan.id === 'seedling' ? 'secondary' : 'primary',
              className: 'w-full',
            })}
          >
            {plan.id === 'seedling'
              ? t('pricing.startFree')
              : t('pricing.choosePlan', { plan: plan.name })}
          </Link>
        )}
      />
      {publishedFooter}
    </>
  );
}
