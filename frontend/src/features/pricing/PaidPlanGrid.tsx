import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { formatCurrency } from '@/i18n/format';
import type { BillingInterval, Plan, PlanId } from '@/services/billingService';
import { intervalIsOffered, priceFor } from './planPricing';

/** Cadences offered in the toggle, in display order. Labels are catalog keys;
 *  the component resolves them so the grid stays translatable. */
const INTERVALS: { id: BillingInterval; labelKey: string; hintKey?: string }[] = [
  { id: 'month', labelKey: 'pricing.intervalMonthly' },
  { id: 'year', labelKey: 'pricing.intervalYearly', hintKey: 'pricing.hintAnnualSaving' },
  { id: 'lifetime', labelKey: 'pricing.intervalLifetime', hintKey: 'pricing.hintOneTime' },
];

/** Feature bullets per tier. Caps come from the API; these are the qualitative
 *  differences that have no numeric field to read.
 *
 *  The lists are cumulative ("Everything in …"), so a bullet on a paid tier
 *  claims the tiers below lack it. Anything every tier can do belongs on
 *  Seedling: import (POST /plants/import) and export (GET /me/export) are open
 *  to every plan — import is bounded only by the plant cap the caps line
 *  already states — while API keys really are Greenhouse-only
 *  (backend/src/handlers/apiKeys/handler.ts). */
const PLAN_FEATURES: Record<PlanId, string[]> = {
  seedling: [
    'pricing.featureReminders',
    'pricing.featureIdentification',
    'pricing.featureSharedHousehold',
    'pricing.featureImportExport',
  ],
  garden: [
    'pricing.featureEverythingSeedling',
    'pricing.featureCareHistory',
    'pricing.featurePriorityIdentification',
  ],
  greenhouse: [
    'pricing.featureEverythingGarden',
    'pricing.featureApiAccess',
    'pricing.featurePrioritySupport',
  ],
};

interface PaidPlanGridProps {
  plans: Plan[];
  /** Household's current tier, when known. Renders a "current plan" marker. */
  currentPlanId?: PlanId;
  /**
   * Rendered as each tier's call to action. Public pricing passes a link to
   * registration; Settings passes a checkout button. Returning null hides the
   * CTA for that tier (free tier, current plan, non-admin viewer).
   */
  renderCta?: (plan: Plan, interval: BillingInterval, price: number | null) => React.ReactNode;
}

/**
 * Paid-plan catalog UI.
 *
 * Prices are NEVER hardcoded here. Every amount comes from GET /billing/plans,
 * whose projection (planSummary in backend/src/models/plans.ts) omits price
 * fields entirely unless the server has proven both commercial gates are open.
 * That keeps one authority for "are we selling, and at what price": a stale
 * client cannot invent an amount, and a price change is a backend deploy
 * rather than a frontend release.
 *
 * A tier that is missing the price for the selected cadence renders as
 * unavailable rather than free — a blank annual id is a valid partial launch
 * (see environments/*.tfvars), and "$0" would be a lie.
 */
export function PaidPlanGrid({ plans, currentPlanId, renderCta }: PaidPlanGridProps) {
  const { t } = useTranslation();
  const offered = useMemo(() => INTERVALS.filter((i) => intervalIsOffered(plans, i.id)), [plans]);
  // Default to the first cadence actually on sale, so a monthly-only launch
  // doesn't open on an empty "Yearly" tab.
  const [interval, setInterval] = useState<BillingInterval>(offered[0]?.id ?? 'month');
  // Guard against the selected cadence disappearing when the catalog refetches.
  const active = offered.some((i) => i.id === interval) ? interval : (offered[0]?.id ?? 'month');

  if (plans.length === 0) return null;

  return (
    <div>
      {offered.length > 1 && (
        <div
          role="group"
          aria-label={t('pricing.intervalLabel')}
          className="mx-auto mt-8 flex w-fit rounded-xl border border-dew bg-paper/85 p-1"
        >
          {offered.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setInterval(option.id)}
              aria-pressed={active === option.id}
              className={clsx(
                'rounded-lg px-4 py-2 text-sm font-medium transition-colors min-h-touch',
                active === option.id ? 'bg-primary-700 text-white' : 'text-ink hover:bg-glass/55'
              )}
            >
              {t(option.labelKey)}
              {option.hintKey && (
                <span
                  className={clsx(
                    'ml-2 text-xs',
                    active === option.id ? 'text-white/80' : 'text-gray-500'
                  )}
                >
                  {t(option.hintKey)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <ul className="mt-10 grid gap-6 md:grid-cols-3" role="list">
        {plans.map((plan) => {
          const price = priceFor(plan, active);
          const isFree = plan.id === 'seedling';
          // Free tier is always purchasable-by-default; a paid tier with no
          // price at this cadence simply isn't sold right now.
          const unavailable = !isFree && price === null;
          const isCurrent = currentPlanId === plan.id;

          return (
            <li
              key={plan.id}
              className={clsx(
                'flex flex-col rounded-2xl border bg-white p-6',
                isCurrent ? 'border-primary-500 ring-1 ring-primary-500' : 'border-primary-100'
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-serif text-2xl tracking-tight text-ink">{plan.name}</h3>
                {isCurrent && (
                  <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-800">
                    {t('pricing.currentPlanBadge')}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-gray-600">{plan.description}</p>

              <p className="mt-4">
                {unavailable ? (
                  <span className="text-sm text-gray-500">
                    {active === 'lifetime'
                      ? t('pricing.notAvailableOneTime')
                      : t('pricing.notAvailableInterval')}
                  </span>
                ) : (
                  <>
                    <span className="font-serif text-3xl tracking-tight text-ink">
                      {formatCurrency(price ?? 0)}
                    </span>
                    <span className="ml-1 text-sm text-gray-600">
                      {active === 'lifetime'
                        ? t('pricing.onceOff')
                        : active === 'year'
                          ? t('pricing.perYear')
                          : t('pricing.perMonth')}
                    </span>
                  </>
                )}
              </p>

              {/* The caps are what actually separates the tiers, so they are
                  set apart from the tier description rather than sharing its
                  styling. Values stay API-sourced. */}
              <p className="mt-4 rounded-lg bg-primary-50 px-3 py-2 text-sm font-medium text-primary-900">
                {t('pricing.planCaps', {
                  plants: plan.maxPlants.toLocaleString(),
                  members: plan.maxMembers.toLocaleString(),
                })}
              </p>

              <ul className="mt-4 space-y-2" role="list">
                {PLAN_FEATURES[plan.id].map((featureKey) => (
                  <li key={featureKey} className="flex items-start gap-2 text-sm text-gray-700">
                    <CheckIcon
                      className="mt-0.5 h-4 w-4 shrink-0 text-primary-700"
                      aria-hidden="true"
                    />
                    {t(featureKey)}
                  </li>
                ))}
              </ul>

              {renderCta && <div className="mt-6 pt-2">{renderCta(plan, active, price)}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
