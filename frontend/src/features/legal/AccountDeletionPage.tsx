import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { LegalShell } from './LegalShell';
import { ACCOUNT_DELETION_MAILTO, SUPPORT_EMAIL } from './contacts';
import { useMetaTags } from '@/hooks/useMetaTags';
import { useAuthStore } from '@/store/authStore';

/** Public, stable URL for Google Play's account-deletion web-link field. */
export function AccountDeletionPage() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  useMetaTags({
    title: t('legal.accountDeletion.metaTitle'),
    description: t('legal.accountDeletion.metaDescription'),
  });

  return (
    <LegalShell title={t('legal.accountDeletion.title')} effectiveDate="2026-09-02">
      <p className="lead">{t('legal.accountDeletion.lead')}</p>
      <h2>{t('legal.accountDeletion.self.heading')}</h2>
      <ol>
        <li>
          {isAuthenticated
            ? t('legal.accountDeletion.self.stepOpenAccount')
            : t('legal.accountDeletion.self.stepSignIn')}
        </li>
        <li>
          <Trans
            i18nKey="legal.accountDeletion.self.stepSelect"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>{t('legal.accountDeletion.self.stepConfirm')}</li>
      </ol>
      <p>{t('legal.accountDeletion.self.loneAdmin')}</p>
      <p>
        <Link to={isAuthenticated ? '/account' : '/login'}>
          {isAuthenticated
            ? t('legal.accountDeletion.self.linkOpenAccount')
            : t('legal.accountDeletion.self.linkSignIn')}
        </Link>
      </p>
      <h2>{t('legal.accountDeletion.request.heading')}</h2>
      <p>
        <Trans
          i18nKey="legal.accountDeletion.request.body"
          values={{ supportEmail: SUPPORT_EMAIL }}
          components={{ supportLink: <a href={ACCOUNT_DELETION_MAILTO}>{SUPPORT_EMAIL}</a> }}
        />
      </p>
      <h2>{t('legal.accountDeletion.effect.heading')}</h2>
      <p>{t('legal.accountDeletion.effect.body')}</p>
    </LegalShell>
  );
}
