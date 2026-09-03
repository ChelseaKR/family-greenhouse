import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { LegalShell } from './LegalShell';
import { HELLO_EMAIL, HELLO_MAILTO, SUPPORT_EMAIL, SUPPORT_MAILTO } from './contacts';
import { useMetaTags } from '@/hooks/useMetaTags';

const AWS_DATA_PRIVACY_URL = 'https://aws.amazon.com/compliance/data-privacy/';

/**
 * Privacy policy. Honest, plain-language version — not the
 * boilerplate-from-a-template variety. Tracks our actual data practices:
 * what we collect, why, who we share with, and the user's rights. Updates
 * here should bump the effective date. A first-login banner announcing
 * policy changes is a known gap, tracked in docs/roadmap.md, not yet built.
 *
 * App-store reviewers (Apple/Google) expect a public privacy URL; this
 * is it. Keep the language readable enough that a non-lawyer can
 * understand what they're agreeing to.
 *
 * Every sentence lives in the `legal.privacy.*` catalog keys; this file is
 * structure only. Wording changes go in both locales (docs/i18n.md).
 */
export function PrivacyPage() {
  const { t } = useTranslation();
  useMetaTags({
    title: t('legal.privacy.metaTitle'),
    description: t('legal.privacy.metaDescription'),
  });

  const strong = { strong: <strong /> };
  const supportLink = <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a>;

  return (
    <LegalShell title={t('legal.privacy.title')} effectiveDate="2026-09-02">
      <p className="lead">
        <Trans
          i18nKey="legal.privacy.lead"
          values={{ helloEmail: HELLO_EMAIL }}
          components={{ helloLink: <a href={HELLO_MAILTO}>{HELLO_EMAIL}</a> }}
        />
      </p>

      <h2>{t('legal.privacy.collect.heading')}</h2>
      <p>{t('legal.privacy.collect.intro')}</p>
      <ul>
        <li>
          <Trans i18nKey="legal.privacy.collect.account" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.collect.plantData" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.collect.location" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.collect.phone" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.collect.notificationCredentials" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.collect.chat" components={strong} />
        </li>
      </ul>

      <p>{t('legal.privacy.collect.telemetryIntro')}</p>
      <ul>
        <li>
          <Trans i18nKey="legal.privacy.collect.telemetryEvents" components={{ code: <code /> }} />
        </li>
        <li>{t('legal.privacy.collect.telemetryRum')}</li>
      </ul>
      <p>
        <Trans i18nKey="legal.privacy.collect.dnt" components={{ code: <code /> }} />
      </p>

      <h2>{t('legal.privacy.thirdParties.heading')}</h2>
      <p>{t('legal.privacy.thirdParties.intro')}</p>
      <ul>
        <li>
          <Trans
            i18nKey="legal.privacy.thirdParties.aws"
            components={{
              strong: <strong />,
              // eslint-disable-next-line jsx-a11y/anchor-has-content -- link text is the <awsLink> span of the catalog string
              awsLink: <a href={AWS_DATA_PRIVACY_URL} />,
            }}
          />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.thirdParties.bedrock" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.thirdParties.stripe" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.thirdParties.plantId" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.thirdParties.perenual" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.thirdParties.openWeatherMap" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.thirdParties.posthog" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.thirdParties.push" components={strong} />
        </li>
        <li>
          <Trans i18nKey="legal.privacy.thirdParties.sentry" components={strong} />
        </li>
        <li>
          <Trans
            i18nKey="legal.privacy.thirdParties.gtm"
            components={{ strong: <strong />, code: <code /> }}
          />
        </li>
      </ul>
      <p>{t('legal.privacy.thirdParties.noSale')}</p>

      <h2>{t('legal.privacy.household.heading')}</h2>
      <p>{t('legal.privacy.household.body')}</p>

      <h2>{t('legal.privacy.sitter.heading')}</h2>
      <p>{t('legal.privacy.sitter.body')}</p>

      <h2>{t('legal.privacy.rights.heading')}</h2>
      <ul>
        <li>
          <Trans
            i18nKey="legal.privacy.rights.export"
            components={{ strong: <strong />, em: <em /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="legal.privacy.rights.delete"
            components={{
              strong: <strong />,
              em: <em />,
              deletionLink: <Link to="/account-deletion" />,
            }}
          />
        </li>
        <li>
          <Trans
            i18nKey="legal.privacy.rights.access"
            values={{ supportEmail: SUPPORT_EMAIL }}
            components={{ strong: <strong />, supportLink }}
          />
        </li>
      </ul>

      <h2>{t('legal.privacy.children.heading')}</h2>
      <p>
        <Trans
          i18nKey="legal.privacy.children.body"
          values={{ supportEmail: SUPPORT_EMAIL }}
          components={{ supportLink }}
        />
      </p>

      <h2>{t('legal.privacy.changes.heading')}</h2>
      <p>{t('legal.privacy.changes.body')}</p>
    </LegalShell>
  );
}
