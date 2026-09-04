import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { buttonStyles } from '@/components/buttonStyles';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useActiveHouseholdRole } from '@/hooks/useActiveHouseholdRole';
import { useAuthStore } from '@/store/authStore';
import { billingService } from '@/services/billingService';
import { householdService } from '@/services/householdService';
import {
  classifyUpgradeRequestError,
  resolveTargetPlan,
  upgradeRequestService,
  type UpgradeFeature,
  type UpgradeRequestFailure,
  type UpgradeRequestResult,
} from '@/services/upgradeRequestService';
import { formatCurrency, formatDate } from '@/i18n/format';
import { formatNameList } from '@/utils/nameList';

/**
 * Everything the ask needs, shared by the card and the inline button. Reads
 * the role of the ACTIVE household, the roster (for the admins' names), the
 * catalog (for "included with Garden" and whether payments are open) and
 * the subscription (for the current tier).
 */
function useUpgradeAsk(feature: UpgradeFeature) {
  const householdId = useActiveHouseholdId();
  const role = useActiveHouseholdRole();
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: !!householdId,
    staleTime: 60_000,
  });
  const householdQuery = useQuery({
    queryKey: ['household', householdId],
    queryFn: () => householdService.getHousehold(householdId!),
    enabled: !!householdId,
    staleTime: 60_000,
  });

  const [sent, setSent] = useState<UpgradeRequestResult | null>(null);
  const [failure, setFailure] = useState<UpgradeRequestFailure | null>(null);
  const mutation = useMutation({
    mutationFn: () => upgradeRequestService.request(householdId!, feature),
    onMutate: () => setFailure(null),
    onSuccess: (result) => setSent(result),
    onError: (error) => setFailure(classifyUpgradeRequestError(error)),
  });

  // Admin names come from the roster the member can already see. When that
  // read has not settled (or failed) the button names nobody rather than
  // guessing — "your household admin" is always true.
  const adminNames =
    householdQuery.data?.members
      .filter((m) => m.role === 'admin' && m.userId !== userId)
      .map((m) => m.name.trim())
      .filter(Boolean) ?? null;

  const plans = plansQuery.data?.plans;
  const currentPlanId = subQuery.data?.planId ?? 'seedling';
  const targetPlanId = resolveTargetPlan(feature, currentPlanId, plans);
  const targetPlan = targetPlanId ? plans?.find((p) => p.id === targetPlanId) : undefined;
  // Fail closed on an unknown catalog: the ask is only offered once the API
  // has said payments are open. A stale or missing catalog means no button.
  const paymentsKnown = plansQuery.data !== undefined;
  const paymentsAvailable = plansQuery.data?.paymentsAvailable === true;

  return {
    householdId,
    role,
    adminNames,
    targetPlan,
    paymentsKnown,
    paymentsAvailable,
    sent,
    failure,
    ask: () => mutation.mutate(),
    isPending: mutation.isPending,
  };
}

interface AskToUpgradeProps {
  feature: UpgradeFeature;
  className?: string;
}

/**
 * The one-tap ask, inline: a button naming the admin(s), then an honest status
 * line. Renders nothing for admins — they have the real controls — and a
 * "paused" line instead of a button while the API says payments are closed.
 * Use inside an existing surface (a plan card); `LockedFeature` wraps it in
 * the full locked card.
 */
export function AskToUpgrade({ feature, className }: AskToUpgradeProps) {
  const { t } = useTranslation();
  const ask = useUpgradeAsk(feature);

  if (ask.role === 'admin') return null;

  const names = ask.adminNames && ask.adminNames.length > 0 ? formatNameList(ask.adminNames) : null;

  if (ask.sent) {
    const sentNames =
      ask.sent.admins.length > 0 ? formatNameList(ask.sent.admins.map((a) => a.name)) : names;
    return (
      <div className={clsx('space-y-1 text-sm', className)} role="status">
        <p className="text-ink">
          {sentNames ? t('locked.sent', { names: sentNames }) : t('locked.sentAdmin')}
        </p>
        {!ask.sent.emailDelivered && <p className="text-gray-600">{t('locked.sentNoEmail')}</p>}
      </div>
    );
  }

  if (ask.paymentsKnown && !ask.paymentsAvailable) {
    return <p className={clsx('text-sm text-gray-600', className)}>{t('locked.paymentsPaused')}</p>;
  }

  return (
    <div className={clsx('space-y-2', className)}>
      <Button
        type="button"
        onClick={ask.ask}
        isLoading={ask.isPending}
        disabled={ask.isPending || !ask.householdId || !ask.paymentsKnown}
      >
        {names ? t('locked.ask', { names }) : t('locked.askAdmin')}
      </Button>
      <p className="text-xs text-gray-600">{t('locked.onceAWeek')}</p>
      {ask.failure && (
        <p className="text-sm text-red-700" role="alert">
          <FailureLine failure={ask.failure} />
        </p>
      )}
    </div>
  );
}

function FailureLine({ failure }: { failure: UpgradeRequestFailure }) {
  const { t } = useTranslation();
  switch (failure.kind) {
    case 'already_asked':
      return failure.nextAllowedAt
        ? t('locked.alreadyAsked', { date: formatDate(failure.nextAllowedAt) })
        : t('locked.alreadyAskedNoDate');
    case 'already_included':
      return t('locked.alreadyIncluded');
    case 'payments_paused':
      return t('locked.paymentsPaused');
    default:
      return t('locked.failed');
  }
}

interface LockedFeatureProps {
  feature: UpgradeFeature;
  /** Heading; defaults to the feature's catalog name. */
  title?: string;
  /** One or two sentences on what the feature does — already translated. */
  children?: ReactNode;
  className?: string;
}

/**
 * A paid feature rendered LOCKED rather than hidden (brief §7d): the member
 * sees what it is, which plan includes it, and gets a one-tap "ask <admin> to
 * upgrade" that sends the admins a real message naming this feature. Admins
 * see the same card with a link to change the plan themselves.
 *
 * Adopting it on a new gated surface: add the feature id to
 * backend/src/models/upgradeFeatures.ts and `locked.features` in both
 * catalogs, then wrap the gated UI in `<LockedFeature feature="…">`.
 */
export function LockedFeature({ feature, title, children, className }: LockedFeatureProps) {
  const { t } = useTranslation();
  const ask = useUpgradeAsk(feature);
  const heading = title ?? t(`locked.features.${feature}`);

  const includedWith = ask.targetPlan
    ? typeof ask.targetPlan.monthlyPrice === 'number'
      ? t('locked.includedWithPrice', {
          plan: ask.targetPlan.name,
          price: formatCurrency(ask.targetPlan.monthlyPrice),
        })
      : t('locked.includedWith', { plan: ask.targetPlan.name })
    : null;

  return (
    <Card variant="paper" className={className}>
      <div className="flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 ring-1 ring-primary-200/60"
          aria-hidden="true"
        >
          <LockClosedIcon className="h-5 w-5 text-primary-800" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-lg text-ink">{heading}</h2>
          {includedWith && (
            <p className="mt-1 text-sm font-medium text-primary-900" data-testid="locked-included">
              {includedWith}
            </p>
          )}
          {children && <p className="mt-2 text-sm text-gray-700">{children}</p>}
          <div className="mt-4">
            {ask.role === 'admin' ? (
              <div className="space-y-2">
                <Link to="/settings/billing" className={buttonStyles({})}>
                  {t('locked.adminChangePlan')}
                </Link>
                <p className="text-xs text-gray-600">{t('locked.adminHint')}</p>
              </div>
            ) : (
              <AskToUpgrade feature={feature} />
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
