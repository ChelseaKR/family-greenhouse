import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/Alert';
import { buttonStyles } from '@/components/buttonStyles';
import { isNativeApp } from '@/lib/platform';
import { getPendingGiftCode } from './pendingGiftCode';

/**
 * "You have a gift code" for a recipient who followed a `/redeem#code` link
 * and then went through sign-up and household creation (ADR 0028). The code
 * was kept in this tab (`pendingGiftCode`); this sends them back to /redeem,
 * where it is filled in. It disappears once the code is redeemed (the form
 * clears it) or the tab is closed. Web only: the apps never mention gifts.
 */
export function PendingGiftCodeNotice() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [code] = useState(() => getPendingGiftCode());
  if (!code || isNativeApp() || pathname === '/redeem') return null;
  return (
    <Alert variant="info" title={t('giftRedeem.pendingTitle')} className="mb-6">
      <div className="space-y-2 text-sm" data-testid="pending-gift-code-notice">
        <p>{t('giftRedeem.pendingBody')}</p>
        <Link to="/redeem" className={buttonStyles({ size: 'sm' })}>
          {t('giftRedeem.pendingCta')}
        </Link>
      </div>
    </Alert>
  );
}
