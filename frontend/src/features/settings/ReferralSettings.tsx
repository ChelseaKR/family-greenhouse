import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUpOnSquareIcon, ClipboardDocumentIcon, GiftIcon } from '@heroicons/react/24/outline';
import { isNativeApp } from '@/lib/platform';
import { shareLinkNatively } from '@/services/nativeShare';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { formatDate } from '@/i18n/format';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { referralService, referralLink } from '@/services/referralService';

/**
 * Refer-a-friend (ADR 0029): the caller's own shareable link and their
 * referral history.
 *
 * Deliberately NOT gated behind `isNativeApp()` the way BillingSettings'
 * purchase buttons, PricingPage and GiftLandingPage all are (App Store
 * guideline 3.1.1). Every one of those hides a real PAYMENT flow — a Stripe
 * Checkout redirect that would collect money outside Apple's IAP. Nothing
 * on this page does: the bonus this page describes is free, granted
 * server-side by `services/referrals.ts` the moment a referred signup
 * creates its own household, with no checkout, no price shown as payable,
 * and no button that starts one. There is nothing here for 3.1.1 to apply
 * to. See `ReferralSettings.test.tsx`'s "no purchase surface" assertion,
 * which is what actually enforces that this stays true.
 */
export function ReferralSettings() {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const [copied, setCopied] = useState(false);
  // In the native shells the link goes out through the share sheet.
  const native = isNativeApp();
  const [copyError, setCopyError] = useState(false);

  const referralQuery = useQuery({
    queryKey: ['referral-status', householdId],
    queryFn: () => referralService.getMyReferral(),
    enabled: !!householdId,
    staleTime: 60_000,
  });

  const handleCopy = async (link: string) => {
    if (await shareLinkNatively({ url: link, dialogTitle: t('common.shareLink') })) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  };

  if (referralQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // A failed read says so — never a silent "0 referrals" (ADR 0010: absence
  // is not a value). `undefined` after loading means the read failed;
  // `referralQuery.data` present-but-empty is a real, honest zero.
  if (!referralQuery.data) {
    return (
      <Card>
        <CardHeader
          title={t('settings.refer.title')}
          description={t('settings.refer.description')}
        />
        <Alert variant="warning" className="mt-4">
          {t('settings.refer.loadError')}
        </Alert>
      </Card>
    );
  }

  const status = referralQuery.data;
  const link = referralLink(status.code);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={t('settings.refer.title')}
          description={t('settings.refer.description')}
        />
        <p className="mt-4 text-sm text-gray-600">{t('settings.refer.howItWorks')}</p>

        <div className="mt-4">
          <label className="label" htmlFor="referral-link">
            {t('settings.refer.linkLabel')}
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              id="referral-link"
              type="text"
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="input flex-1 font-mono text-sm"
              data-testid="referral-link-input"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleCopy(link)}
              className="shrink-0"
            >
              {native ? (
                <ArrowUpOnSquareIcon className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
              )}
              {native
                ? t('common.shareLink')
                : copied
                  ? t('settings.refer.copiedConfirmation')
                  : t('settings.refer.copyButton')}
            </Button>
          </div>
          {copyError && (
            <p className="mt-2 text-sm text-gray-600" data-testid="referral-copy-fallback">
              {link}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={t('settings.refer.statsHeading')} />
        {status.referrals.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">{t('settings.refer.statsEmpty')}</p>
        ) : (
          <>
            <p className="mt-4 text-sm font-medium text-ink">
              {t('settings.refer.statsSummary', {
                granted: status.grantedReferrals,
                total: status.totalReferrals,
              })}
            </p>
            <ul className="mt-4 space-y-3" role="list">
              {status.referrals.map((entry) => (
                <li
                  key={entry.signedUpAt}
                  className="flex items-center gap-3 rounded-lg border border-primary-100/80 p-3"
                  data-testid="referral-row"
                  data-rewarded={entry.rewarded}
                >
                  <GiftIcon
                    className={`h-5 w-5 shrink-0 ${entry.rewarded ? 'text-primary-600' : 'text-gray-400'}`}
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-sm text-ink">{formatDate(entry.signedUpAt)}</p>
                    <p className="text-xs text-gray-600">
                      {t(
                        entry.rewarded ? 'settings.refer.rowGranted' : 'settings.refer.rowSkipped'
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
