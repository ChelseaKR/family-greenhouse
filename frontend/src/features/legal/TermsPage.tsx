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
 *
 * The commercial sections — trial, renewal, cancellation, price changes,
 * one-time purchases and refunds — describe what the billing code actually
 * does, not a policy written ahead of it. Each claim is traceable: the
 * 14-day trial is `trial_period_days: 14` in services/billing.ts,
 * cancellation runs through the Stripe portal (`createPortalSession`,
 * admin-only) and holds the plan until `customer.subscription.deleted` drops
 * it to seedling, the withdrawn cadences are `withdrawnIntervals` in
 * models/plans.ts, the refund section describes a system with no refund path
 * at all (see the comment beside it), and the caps that bite after a
 * downgrade are enforced on create/import/invite only, never on read or edit.
 * Change the behaviour and this text has to change with it.
 */
export function TermsPage() {
  const { t } = useTranslation();
  useMetaTags({
    title: t('legal.terms.metaTitle'),
    description: t('legal.terms.metaDescription'),
  });

  return (
    <LegalShell title={t('legal.terms.title')} effectiveDate="2026-09-12">
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

      <h2>{t('legal.terms.trial.heading')}</h2>
      <p>{t('legal.terms.trial.intro')}</p>
      <p>
        <Trans i18nKey="legal.terms.trial.ending" components={{ em: <em /> }} />
      </p>

      <h2>{t('legal.terms.renewal.heading')}</h2>
      <p>{t('legal.terms.renewal.cadence')}</p>
      <p>{t('legal.terms.renewal.price')}</p>

      <h2>{t('legal.terms.cancellation.heading')}</h2>
      <p>
        <Trans i18nKey="legal.terms.cancellation.how" components={{ em: <em /> }} />
      </p>
      <p>{t('legal.terms.cancellation.when')}</p>
      <p>{t('legal.terms.cancellation.whatRemains')}</p>

      <h2>{t('legal.terms.priceChanges.heading')}</h2>
      <p>{t('legal.terms.priceChanges.body')}</p>

      <h2>{t('legal.terms.oneTimePurchases.heading')}</h2>
      <p>{t('legal.terms.oneTimePurchases.body')}</p>
      <p>{t('legal.terms.oneTimePurchases.packs')}</p>

      {/*
        Refunds (#426). Every sentence here describes what the billing code
        does, and nothing here promises a refund the system could not make:
        no path in `backend/src` calls Stripe's refund API,
        `accountCleanup.cancelAbandonedHouseholdSubscription` cancels with no
        proration and no refund requested, and a refund — if one is agreed —
        is issued by hand in the Stripe dashboard. Both halves of that are
        held to the code by `backend/tests/unit/config/refundPosture.test.ts`,
        so adding a refund path here without re-reading this section fails the
        build. What is NOT stated is a refund window: there is no clock on a
        refund request anywhere in the product, so a stated window would be a
        commitment nothing tracks. See `docs/billing.md` § Refunds.
      */}
      <h2>{t('legal.terms.refunds.heading')}</h2>
      <p>{t('legal.terms.refunds.cancelling')}</p>
      <p>
        <Trans
          i18nKey="legal.terms.refunds.policy"
          values={{ supportEmail: SUPPORT_EMAIL }}
          components={{ supportLink: <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a> }}
        />
      </p>
      <p>{t('legal.terms.refunds.oneTime')}</p>
      <p>{t('legal.terms.refunds.statutory')}</p>

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
