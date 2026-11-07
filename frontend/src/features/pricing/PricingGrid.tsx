import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';
import { buttonStyles } from '@/components/buttonStyles';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { isNativeApp } from '@/lib/platform';
import { billingService } from '@/services/billingService';
import { PaidPlanGrid } from './PaidPlanGrid';
import { PLAN_PRICES, offeredPrices } from './planPrices';

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
  // Never inside the iOS/Android shells. Neither store lets the app show a
  // price for a subscription it does not sell through In-App Purchase, nor a
  // button toward one (Apple 3.1.1, Play Payments). The only page that renders
  // this grid, the landing page, is no longer where a signed-out native user
  // starts (App.tsx sends them to /login), and the native /pricing route has
  // its own purchase-free copy. This guard keeps the next caller that embeds
  // the grid on a page the shells can reach from repeating #804's defect.
  if (isNativeApp()) return null;
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

/**
 * The monthly prices, in words, while the catalog is still on its way.
 *
 * Why this exists: the grid below is filled from `GET /billing/plans`, so the
 * prerendered /pricing HTML (written at build time) and the first paint held
 * a spinner and no dollar amount at all. A crawler that runs no JavaScript,
 * and a person who has not waited for the request, read a pricing page with
 * no price on it (measured on the live page, 2026-10-23: no `$` in the body
 * text, while the JSON-LD carried 4.99).
 *
 * Where the number comes from: `PLAN_PRICES`, the mirror of
 * `backend/src/models/plans.ts` that the /pricing structured data already
 * uses and that `planPrices.test.ts` holds equal to the backend catalog. A
 * cadence the catalog has withdrawn (annual, lifetime) is never named, because
 * `offeredPrices` leaves it out.
 *
 * Why it is safe: it renders only here, inside `PublishedPlanCatalog`, which
 * is only reached when the repository hold is off, and only while the query is
 * in flight. The moment the API answers, this line is gone: the amounts come
 * from the response, and an unavailable or failed catalog renders the
 * fail-closed notice with no amount on screen. It is also the markup the
 * client's first render produces, so hydration matches.
 */
function LoadingPriceLine() {
  const { t } = useTranslation();
  const monthly = (id: 'garden' | 'greenhouse') => {
    const plan = PLAN_PRICES.find((candidate) => candidate.id === id);
    const offer = plan && offeredPrices(plan).find((o) => o.interval === 'month');
    return offer ? offer.amount.toFixed(2) : null;
  };
  const garden = monthly('garden');
  const greenhouse = monthly('greenhouse');
  if (garden === null || greenhouse === null) return null;
  return (
    <p
      data-testid="plan-price-line"
      className="mx-auto mt-10 max-w-2xl text-center text-base leading-7 text-gray-800"
    >
      {t('pricing.monthlyPriceLine', { garden, greenhouse })}
    </p>
  );
}

function PublishedPlanCatalog({ publishedFooter }: PricingGridProps) {
  const { t } = useTranslation();
  const plansQuery = useQuery({
    queryKey: ['plans'],
    queryFn: billingService.listPlans,
  });

  if (plansQuery.isLoading) {
    return (
      <>
        <LoadingPriceLine />
        <div className="flex justify-center py-12">
          <LoadingSpinner size="lg" />
        </div>
      </>
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
