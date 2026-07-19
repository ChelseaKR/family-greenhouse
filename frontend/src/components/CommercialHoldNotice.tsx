import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { COMMERCIAL_HOLD_EFFECTIVE_DATE } from '@/config/commercialStatus';

interface CommercialHoldNoticeProps {
  className?: string;
  compact?: boolean;
}

/** Neutral status notice used where paid-plan controls would otherwise appear. */
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
        {t('commercialHold.headline')}
      </h2>
      <p className={clsx('mt-3 leading-6', compact ? 'text-xs' : 'text-sm')}>
        {t('commercialHold.message')}
      </p>
      <p className="mt-3 text-xs text-amber-800">
        {t('commercialHold.effectiveDate', { date: COMMERCIAL_HOLD_EFFECTIVE_DATE })}
      </p>
    </section>
  );
}
