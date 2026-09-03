import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { LegalShell } from './LegalShell';
import { HELLO_EMAIL, HELLO_MAILTO, SUPPORT_EMAIL, SUPPORT_MAILTO } from './contacts';
import { useMetaTags } from '@/hooks/useMetaTags';

/**
 * Terms of service. Plain-language, beta-honest. App stores require a
 * public terms URL; this is it.
 *
 * NOT legal advice. Replace with counsel-reviewed copy before any
 * material commercial commitments (paid plans at scale, B2B contracts,
 * EU/UK distribution past the GDPR-relevant threshold).
 *
 * Every sentence lives in the `legal.terms.*` catalog keys; this file is
 * structure only. Wording changes go in both locales (docs/i18n.md).
 */
export function TermsPage() {
  const { t } = useTranslation();
  useMetaTags({
    title: t('legal.terms.metaTitle'),
    description: t('legal.terms.metaDescription'),
  });

  return (
    <LegalShell title={t('legal.terms.title')} effectiveDate="2026-09-02">
      <p className="lead">
        <Trans
          i18nKey="legal.terms.lead"
          values={{ helloEmail: HELLO_EMAIL }}
          components={{ helloLink: <a href={HELLO_MAILTO}>{HELLO_EMAIL}</a> }}
        />
      </p>

      <h2>{t('legal.terms.agreement.heading')}</h2>
      <p>{t('legal.terms.agreement.body')}</p>

      <h2>{t('legal.terms.eligibility.heading')}</h2>
      <p>
        <Trans
          i18nKey="legal.terms.eligibility.body"
          values={{ supportEmail: SUPPORT_EMAIL }}
          components={{ supportLink: <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a> }}
        />
      </p>

      <h2>{t('legal.terms.fromUs.heading')}</h2>
      <ul>
        <li>
          <Trans
            i18nKey="legal.terms.fromUs.service"
            components={{ strong: <strong />, em: <em /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="legal.terms.fromUs.data"
            components={{ strong: <strong />, privacyLink: <Link to="/legal/privacy" /> }}
          />
        </li>
        <li>
          <Trans i18nKey="legal.terms.fromUs.notice" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="legal.terms.fromUs.plans" components={{ strong: <strong /> }} />
        </li>
      </ul>

      <h2>{t('legal.terms.fromYou.heading')}</h2>
      <ul>
        <li>
          <Trans i18nKey="legal.terms.fromYou.abuse" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="legal.terms.fromYou.illegal" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="legal.terms.fromYou.honest" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="legal.terms.fromYou.housemates" components={{ strong: <strong /> }} />
        </li>
      </ul>

      <h2>{t('legal.terms.termination.heading')}</h2>
      <p>
        <Trans i18nKey="legal.terms.termination.body" components={{ em: <em /> }} />
      </p>

      <h2>{t('legal.terms.planStatus.heading')}</h2>
      <p>
        <Trans i18nKey="legal.terms.planStatus.body" components={{ em: <em /> }} />
      </p>

      <h2>{t('legal.terms.limitations.heading')}</h2>
      <p>{t('legal.terms.limitations.asIs')}</p>
      <p>{t('legal.terms.limitations.advice')}</p>

      <h2>{t('legal.terms.disputes.heading')}</h2>
      <p>{t('legal.terms.disputes.body')}</p>

      <h2>{t('legal.terms.changes.heading')}</h2>
      <p>{t('legal.terms.changes.body')}</p>

      <p className="text-sm text-gray-500 mt-12">{t('legal.terms.counselNote')}</p>
    </LegalShell>
  );
}
