import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { formatCurrency } from '@/i18n/format';
import type { BillingInterval, Plan, PlanFeatures, PlanId } from '@/services/billingService';
import { capsLine, intervalIsOffered, priceFor } from './planPricing';

/** Cadences offered in the toggle, in display order. Labels are catalog keys;
 *  the component resolves them so the grid stays translatable. */
const INTERVALS: { id: BillingInterval; labelKey: string; hintKey?: string }[] = [
  { id: 'month', labelKey: 'pricing.intervalMonthly' },
  { id: 'year', labelKey: 'pricing.intervalYearly', hintKey: 'pricing.hintAnnualSaving' },
  { id: 'lifetime', labelKey: 'pricing.intervalLifetime', hintKey: 'pricing.hintOneTime' },
];

/** The tier's one-line story, translated; the API's `description` is the
 *  fallback for a locale without one. */
const TAGLINE_KEY: Record<PlanId, string> = {
  seedling: 'pricing.taglineSeedling',
  garden: 'pricing.taglineGarden',
  greenhouse: 'pricing.taglineGreenhouse',
};

/** Feature bullets per tier. Caps come from the API (the caps line); these
 *  are the qualitative differences that have no numeric field to read.
 *
 *  The lists are cumulative ("Everything in …"), so a bullet on a paid tier
 *  claims the tiers below lack it. Anything every tier can do belongs on
 *  Seedling: import (POST /plants/import), export (GET /me/export) and the
 *  .ics feed are open to every plan, and so is the care history — the free
 *  tier's 30-day window is an ANALYTICS window, not a history one.
 *
 *  Every bullet here is checkable against code today. A capability that has
 *  not shipped is not listed, whatever the catalog's `features` map says —
 *  see FEATURE_BULLETS.
 *
 *  Greenhouse carried "Priority support" until #607. There is no support
 *  tiering anywhere in the repo: features/legal/SupportPage.tsx hands the one
 *  SUPPORT_EMAIL to every plan, nothing reads a household's tier when a
 *  request arrives, and there is no queue, routing rule or response-time
 *  target to read. It was a service commitment sold at $9.99/mo with nothing
 *  behind it. It goes back when something implements it.
 *
 *  Garden's identification bullet says "more each month", not "priority",
 *  because that is what the code does: IDENTIFY_ALLOWANCES in
 *  backend/src/services/identifyBudget.ts gives Seedling 1, Garden 30 and
 *  Greenhouse 100 per calendar month (enforced in production —
 *  identify_metering_enabled = "1"). It is a larger allowance; there is no
 *  queue, and a Garden identification is not faster than a free one. The
 *  numbers stay out of the bullet: they live in one place and a copy here
 *  would be a second one to keep in step. */
const PLAN_FEATURES: Record<PlanId, string[]> = {
  seedling: [
    'pricing.featureSharedHousehold',
    'pricing.featureReminders',
    'pricing.featureSitterBasic',
    'pricing.featureAnalytics30',
    'pricing.featureIdentification',
    'pricing.featureImportExport',
  ],
  garden: [
    'pricing.featureEverythingSeedling',
    'pricing.featureUnlimitedMembers',
    'pricing.featureFullHistory',
    'pricing.featureMoreIdentification',
  ],
  greenhouse: ['pricing.featureEverythingGarden', 'pricing.featureManyHomes'],
};

/**
 * Bullets driven by the catalog's `features` map (backend/src/models/plans.ts).
 * One renders on a tier when that tier has the flag AND the tier below does
 * not — "new here", so the cumulative lists never repeat a bullet.
 *
 * An entry is added by the change that SHIPS the capability, never before:
 * the flag says the tier includes it, this list says it exists. The Away Kit,
 * Plant Tags, the household toolkit, Move Day, kiosk and caretaker seats each
 * add their own line when they land (`awayKit`, `plantTags`,
 * `householdToolkit`, `moveDay`, `kiosk`, `caretakerSeats`).
 */
const FEATURE_BULLETS: ReadonlyArray<{ flag: keyof PlanFeatures; key: string }> = [
  { flag: 'chat', key: 'pricing.featureChat' },
  { flag: 'apiKeys', key: 'pricing.featureApiAccess' },
];

/** Ascending entitlement order, mirroring PLAN_ORDER in backend/src/models/plans.ts. */
const TIER_ORDER: readonly PlanId[] = ['seedling', 'garden', 'greenhouse'];

/**
 * Flag bullets that are NEW on `plan` — it has the capability and no tier
 * below it does. Resolved through TIER_ORDER rather than the array's own
 * order, because the cumulative "Everything in …" lists only read correctly
 * if "below" means a lower tier; a catalog that arrived in another order
 * would otherwise hang the assistant bullet on Greenhouse and leave Garden
 * claiming nothing.
 */
function newFeatureBullets(plan: Plan, catalog: Plan[]): string[] {
  if (!plan.features) return [];
  const rank = TIER_ORDER.indexOf(plan.id);
  const lower = catalog.filter((p) => TIER_ORDER.indexOf(p.id) < rank);
  return FEATURE_BULLETS.filter(
    ({ flag }) => plan.features?.[flag] === true && !lower.some((p) => p.features?.[flag] === true)
  ).map(({ key }) => key);
}

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
          const bullets = [...PLAN_FEATURES[plan.id], ...newFeatureBullets(plan, plans)];

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
              <p className="mt-1 text-sm text-gray-600">
                {t(TAGLINE_KEY[plan.id], { defaultValue: plan.description })}
              </p>

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

              {/* Homes, hands and plants are what separate the tiers (ADR
                  0014), so they are set apart from the tagline rather than
                  sharing its styling. Values stay API-sourced. */}
              <p className="mt-4 rounded-lg bg-primary-50 px-3 py-2 text-sm font-medium text-primary-900">
                {capsLine(plan, t)}
              </p>

              <ul className="mt-4 space-y-2" role="list">
                {bullets.map((featureKey) => (
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
