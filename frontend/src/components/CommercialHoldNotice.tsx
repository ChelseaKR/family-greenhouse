import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { COMMERCIAL_HOLD_ACTIVE, COMMERCIAL_HOLD_EFFECTIVE_DATE } from '@/config/commercialStatus';

interface CommercialHoldNoticeProps {
  className?: string;
  compact?: boolean;
}

/**
 * Neutral status notice used where paid-plan controls would otherwise appear.
 *
 * It covers two different situations and must not conflate them. While the
 * repository-level hold is active it states the hold and its effective date.
 * Once the hold lifts, this same notice is still the fail-closed fallback for
 * an environment whose runtime gate is shut (or a frontend running ahead of
 * its backend) — there is no commercial hold to cite there, so it says only
 * that payments are unavailable. Citing a lifted hold, or a date that no
 * longer describes anything, would be inaccurate.
 */
export function CommercialHoldNotice({ className, compact = false }: CommercialHoldNoticeProps) {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={clsx(
        'rounded-2xl border border-amber-200 bg-amber-50 text-center text-amber-950',
        compact ? 'p-4' : 'p-6',
        className
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wide">
        {t('commercialHold.statusLabel')}
      </p>
      <h2
        id={titleId}
        className={clsx('mt-2 font-serif tracking-tight', compact ? 'text-xl' : 'text-3xl')}
      >
        {COMMERCIAL_HOLD_ACTIVE
          ? t('commercialHold.headline')
          : t('commercialHold.unavailableHeadline')}
      </h2>
      <p className={clsx('mt-3 leading-6', compact ? 'text-xs' : 'text-sm')}>
        {COMMERCIAL_HOLD_ACTIVE
          ? t('commercialHold.message')
          : t('commercialHold.unavailableMessage')}
      </p>
      {COMMERCIAL_HOLD_ACTIVE && (
        <p className="mt-3 text-xs text-amber-800">
          {t('commercialHold.effectiveDate', { date: COMMERCIAL_HOLD_EFFECTIVE_DATE })}
        </p>
      )}
    </section>
  );
}
