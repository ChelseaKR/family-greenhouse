import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShareIcon } from '@heroicons/react/24/outline';
import { formatCurrency } from '@/i18n/format';
import { siteUrl } from '@/config/site';
import type { BillingInterval } from '@/services/billingService';
import { centsToDollars, splitDollars } from './billSplit';

interface SplitTheBillProps {
  /** Catalog amount in dollars at the selected cadence. */
  amount: number;
  interval: BillingInterval;
  planName: string;
  /** Live active-member count from GET /billing/me. `null` = unknown, and an
   *  unknown count is never rendered as a split. */
  memberCount: number | null;
  /** Household display name for the share line; `null` = unknown. */
  householdName: string | null;
}

/**
 * "$4.99 ÷ 4 members = $1.25 each" (brief §4.12) — computed from the live
 * catalog price and the household's real member count, with a share action
 * that uses the Web Share API where the platform has one and copies a plain
 * text line otherwise.
 *
 * Factual on purpose: the line is arithmetic, the note says what it is not,
 * and there is no nudge copy. Hidden for a household of one (nothing to
 * split) and whenever the member count is unknown (a split of "—" members
 * is not a number).
 */
export function SplitTheBill({
  amount,
  interval,
  planName,
  memberCount,
  householdName,
}: SplitTheBillProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<'copied' | 'copy_failed' | null>(null);

  if (memberCount === null || memberCount < 2) return null;
  const split = splitDollars(amount, memberCount);
  if (!split) return null;

  const cadence =
    interval === 'lifetime'
      ? t('pricing.onceOff')
      : interval === 'year'
        ? t('pricing.perYear')
        : t('pricing.perMonth');
  const total = formatCurrency(centsToDollars(split.totalCents));
  const each = formatCurrency(centsToDollars(split.highCents));
  const line = t(split.evenly ? 'settings.billing.splitLine' : 'settings.billing.splitLineApprox', {
    total,
    n: split.members,
    each,
  });
  const shareText = t('settings.billing.splitShareText', {
    household: householdName ?? t('settings.billing.splitHouseholdFallback'),
    plan: planName,
    total,
    cadence,
    each,
    n: split.members,
    url: siteUrl('/settings/billing'),
  });

  const share = async () => {
    setFeedback(null);
    const nav = navigator as Navigator & { share?: (data: { text: string }) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ text: shareText });
        return;
      } catch {
        // A dismissed share sheet is not an error; fall through to the
        // clipboard only when sharing genuinely is not available.
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      setFeedback('copied');
    } catch {
      setFeedback('copy_failed');
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-dew/70 bg-paper/70 px-3 py-2 text-sm text-gray-700">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span data-testid="split-line" className="font-medium text-ink">
          {line}
        </span>
        <span className="text-xs text-gray-600">{cadence}</span>
      </p>
      {!split.evenly && (
        <p className="mt-1 text-xs text-gray-600" data-testid="split-exact">
          {t('settings.billing.splitExact', {
            high: split.highCount,
            highAmount: formatCurrency(centsToDollars(split.highCents)),
            low: split.lowCount,
            lowAmount: formatCurrency(centsToDollars(split.lowCents)),
          })}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void share()}
          className="inline-flex min-h-touch items-center gap-1.5 text-sm font-medium text-primary-800 hover:text-primary-900"
          aria-label={t('settings.billing.splitShareAria', { plan: planName })}
        >
          <ShareIcon className="h-4 w-4" aria-hidden="true" />
          {t('settings.billing.splitShare')}
        </button>
        {feedback === 'copied' && (
          <span role="status" className="text-xs text-primary-800">
            {t('settings.billing.splitCopied')}
          </span>
        )}
        {feedback === 'copy_failed' && (
          <span role="alert" className="text-xs text-red-700">
            {t('settings.billing.splitCopyFailed')}
          </span>
        )}
      </div>
    </div>
  );
}
