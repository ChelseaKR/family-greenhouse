import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { LegalShell } from './LegalShell';
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from './contacts';
import { useMetaTags } from '@/hooks/useMetaTags';

/**
 * Public support URL used by both store listings and app review.
 *
 * `legal.support.help.body` describes the help pages as public and lists the
 * nine topics `/help/:topicId` serves. That is the state once #389
 * (feat/help-content) merges and moves `/help` out of ProtectedRoute; on a
 * `main` without #389 the help pages still require sign-in. If #389 is closed
 * rather than merged, restore the signed-in wording in both catalogs.
 */
export function SupportPage() {
  const { t } = useTranslation();
  useMetaTags({
    title: t('legal.support.metaTitle'),
    description: t('legal.support.metaDescription'),
  });

  return (
    <LegalShell title={t('legal.support.title')} effectiveDate="2026-09-02">
      <p className="lead">
        <Trans
          i18nKey="legal.support.lead"
          values={{ supportEmail: SUPPORT_EMAIL }}
          components={{ supportLink: <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a> }}
        />
      </p>
      <h2>{t('legal.support.account.heading')}</h2>
      <p>
        <Trans
          i18nKey="legal.support.account.body"
          components={{ deletionLink: <Link to="/account-deletion" /> }}
        />
      </p>
      <h2>{t('legal.support.help.heading')}</h2>
      <p>
        <Trans i18nKey="legal.support.help.body" components={{ helpLink: <Link to="/help" /> }} />
      </p>
      <h2>{t('legal.support.status.heading')}</h2>
      <p>
        <Trans
          i18nKey="legal.support.status.body"
          components={{ statusLink: <Link to="/status" /> }}
        />
      </p>
    </LegalShell>
  );
}
