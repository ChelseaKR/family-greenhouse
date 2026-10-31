import { Trans, useTranslation } from 'react-i18next';
import { AGE_ASSURANCE_POLICY } from '@/config/ageAssurance';
import { accountMinimumAge } from '@/lib/ageSignal';
import { SUPPORT_EMAIL } from '@/features/legal/contacts';
import { AuthShell } from './AuthShell';

/**
 * What a person the store reports as below the account line sees instead of
 * sign-up, sign-in, an invitation or the app. A plain message for a parent
 * and the support address; no age field and no "try again".
 */
export default function AgeBlockedNotice() {
  const { t } = useTranslation();
  const age = accountMinimumAge(AGE_ASSURANCE_POLICY);
  return (
    <AuthShell title={t('ageGate.title')}>
      <div className="space-y-4 text-left text-ink" data-testid="age-blocked-notice">
        <p>{t('ageGate.body', { age })}</p>
        <p>
          <Trans
            i18nKey="ageGate.parent"
            values={{ age, supportEmail: SUPPORT_EMAIL }}
            components={{
              supportLink: (
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="font-medium text-primary-700 underline hover:text-primary-600"
                >
                  {SUPPORT_EMAIL}
                </a>
              ),
            }}
          />
        </p>
      </div>
    </AuthShell>
  );
}
