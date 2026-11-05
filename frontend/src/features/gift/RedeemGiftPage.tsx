import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { Card, CardHeader } from '@/components/Card';
import { buttonStyles } from '@/components/buttonStyles';
import { useMetaTags } from '@/hooks/useMetaTags';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { useAuthStore } from '@/store/authStore';
import { isNativeApp } from '@/lib/platform';
import { billingService } from '@/services/billingService';
import { normalizeGiftCodeInput } from './giftLink';
import { getPendingGiftCode, setPendingGiftCode } from './pendingGiftCode';
import { GiftRedeemForm } from './GiftRedeemForm';

/**
 * Read the code a shared `/redeem#FG-…` link carries, keep it for the rest of
 * this visit, and take it out of the address bar. Runs once, before first
 * paint of the content, so a code is never left in a URL someone screenshots.
 */
function useCodeFromLink(): { code: string | null; stored: boolean } {
  const [state] = useState(() => {
    let fromHash: string | null = null;
    try {
      if (typeof window !== 'undefined') {
        fromHash = normalizeGiftCodeInput(window.location.hash.replace(/^#/, ''));
      }
    } catch {
      fromHash = null;
    }
    if (fromHash) {
      const stored = setPendingGiftCode(fromHash);
      return { code: fromHash, stored, fromHash: true };
    }
    const pending = getPendingGiftCode();
    return { code: pending, stored: pending !== null, fromHash: false };
  });
  useEffect(() => {
    if (!state.fromHash) return;
    try {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    } catch {
      // Leaving the fragment in place is harmless: it is never sent anywhere.
    }
  }, [state.fromHash]);
  return { code: state.code, stored: state.stored };
}

/**
 * Public /redeem page: the recipient's door to a gift (ADR 0028).
 *
 * The buyer shares `https://familygreenhouse.net/redeem#FG-XXXX-…`. A new
 * recipient has to register, confirm, sign in and create a household before
 * there is anything to redeem onto, and onboarding does not honor
 * `?redirect=`. So the code is kept in sessionStorage (`pendingGiftCode`) for
 * the whole of that trip, and the app shows "You have a gift code" once a
 * household exists (`PendingGiftCodeNotice`). Where storage is blocked the
 * page says to paste the code after signing in; nothing is lost.
 *
 * Web only, like /gift: the apps never mention gifts (App Store Guideline
 * 3.1.1), so inside the native shell this opens Settings → Plan status.
 */
export function RedeemGiftPage() {
  const { t } = useTranslation();
  const native = isNativeApp();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hasHousehold = useAuthStore((s) => s.user?.householdId != null);
  const isAdmin = useIsHouseholdAdmin();
  const { code, stored } = useCodeFromLink();
  const plansQuery = useQuery({
    queryKey: ['plans'],
    queryFn: billingService.listPlans,
    enabled: !native,
  });

  useMetaTags({
    title: t('giftRedeem.metaTitle'),
    description: t('giftRedeem.metaDescription'),
    // A page that may hold a bearer code is never indexed.
    robots: 'noindex, nofollow',
  });

  if (native) return <Navigate to="/settings/billing" replace />;

  const codeLine = code ? (
    <p className="mt-3 text-sm text-gray-900" data-testid="redeem-code-line">
      {t('giftRedeem.yourCode')}{' '}
      <code className="font-mono tracking-wider" data-testid="redeem-code">
        {code}
      </code>
    </p>
  ) : null;
  const keptLine = code ? (
    <p className="mt-2 text-sm text-gray-700" data-testid="redeem-kept">
      {stored ? t('giftRedeem.codeKept') : t('giftRedeem.codeNotKept')}
    </p>
  ) : null;

  let body: ReactNode;
  if (!isAuthenticated) {
    body = (
      <Card variant="paper">
        <CardHeader
          title={t('giftRedeem.signInHeading')}
          description={t('giftRedeem.signInBody')}
        />
        {codeLine}
        {keptLine}
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            to={`/register?redirect=${encodeURIComponent('/redeem')}`}
            className={buttonStyles({ size: 'lg' })}
          >
            {t('giftRedeem.registerCta')}
          </Link>
          <Link
            to={`/login?redirect=${encodeURIComponent('/redeem')}`}
            className={buttonStyles({ variant: 'secondary', size: 'lg' })}
          >
            {t('giftRedeem.signInCta')}
          </Link>
        </div>
      </Card>
    );
  } else if (!hasHousehold) {
    body = (
      <Card variant="paper">
        <CardHeader
          title={t('giftRedeem.noHouseholdHeading')}
          description={t('giftRedeem.noHouseholdBody')}
        />
        {codeLine}
        {keptLine}
        <div className="mt-4">
          <Link to="/onboarding" className={buttonStyles({ size: 'lg' })}>
            {t('giftRedeem.noHouseholdCta')}
          </Link>
        </div>
      </Card>
    );
  } else if (!isAdmin) {
    body = (
      <Card variant="paper">
        <CardHeader
          title={t('giftRedeem.notAdminHeading')}
          description={t('giftRedeem.notAdminBody')}
        />
        {codeLine}
      </Card>
    );
  } else {
    body = (
      <Card variant="paper">
        <CardHeader
          title={t('giftRedeem.formHeading')}
          description={t('giftSubscription.redeemBody')}
        />
        <GiftRedeemForm
          plans={plansQuery.data?.plans}
          initialCode={code ?? ''}
          idPrefix="redeem-page"
        />
      </Card>
    );
  }

  return (
    <PublicShell>
      <PageIntro
        eyebrow={t('giftLanding.eyebrow')}
        title={t('giftRedeem.title')}
        lede={t('giftRedeem.lede')}
      />
      <div className="mt-10" data-testid="redeem-page">
        {body}
        <p className="mt-6 text-sm text-gray-600" data-testid="redeem-trial-overlap">
          {t('giftRedeem.trialOverlap')}
        </p>
      </div>
    </PublicShell>
  );
}

export default RedeemGiftPage;
