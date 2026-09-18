import { Link } from 'react-router';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { buttonStyles } from '@/components/buttonStyles';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { PricingGrid } from './PricingGrid';
import { pricingJsonLd } from './pricingJsonLd';
import { isNativeApp } from '@/lib/platform';
import { useTranslation } from 'react-i18next';
import { PUBLIC_REGISTRATION_AVAILABLE, COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';

/**
 * The "why would I pay for a plant app" band. Four claims, each one true of
 * the shipped product and checkable against code. The line between tiers is
 * homes and hands, not collection size (ADR 0014):
 *
 *  - per-household billing: one subscription per household id
 *    (backend/src/models/plans.ts, services/billing.ts);
 *  - a household that has to coordinate: Garden's member cap is unlimited
 *    where free is three, and the analytics window is the full history where
 *    free renders 30 days (`limits` in models/plans.ts);
 *  - many homes, many hands: Greenhouse's `homes` limit is unlimited where
 *    free and Garden are one (services/homesGate.ts), and API keys are
 *    Greenhouse-only (handlers/apiKeys);
 *  - nothing locked away: cancelling returns the household to the free tier,
 *    over-cap records stay readable and editable, and household export is not
 *    plan-gated (GET /me/export requires auth only).
 *
 * The caps in the grid above stay API-sourced; the numbers in the copy here
 * are the free tier's, which the acquisition-surface test pins.
 */
const WHY_PAID_POINTS = [
  { title: 'pricing.whyHouseholdTitle', body: 'pricing.whyHouseholdBody' },
  { title: 'pricing.whyCoordinateTitle', body: 'pricing.whyCoordinateBody' },
  { title: 'pricing.whyHomesTitle', body: 'pricing.whyHomesBody' },
  { title: 'pricing.whyLeaveTitle', body: 'pricing.whyLeaveBody' },
] as const;

/** Standalone public status page retained at /pricing for stable links. */
export function PricingPage() {
  const { t } = useTranslation();
  const native = isNativeApp();
  // Which of the three commercial states the hero and metadata describe. The
  // copy is `pricingPage.*` in the catalogs (#467).
  const state = COMMERCIAL_HOLD_ACTIVE
    ? PUBLIC_REGISTRATION_AVAILABLE
      ? 'heldOpen'
      : 'heldClosed'
    : 'open';
  useMetaTags({
    title: t(`pricingPage.meta.title.${state}`),
    description: t(`pricingPage.meta.description.${state}`),
    canonical: siteUrl('/pricing'),
    // SoftwareApplication + Offer, from the guarded price mirror rather than
    // from the runtime catalog: the prerendered HTML is written at build time,
    // long before any fetch, and it is the only version of this page a crawler
    // that runs no JavaScript ever sees. Which offers may be published — and
    // why there is no aggregateRating — is decided in `pricingJsonLd`.
    jsonLd: pricingJsonLd(),
  });

  if (native) {
    return (
      <PublicShell>
        <PageIntro
          eyebrow={t('pricingPage.native.eyebrow')}
          title={t('pricingPage.native.title')}
          lede={t('pricingPage.native.lede')}
        />
        <section className="mt-12 rounded-2xl border border-primary-100 bg-white p-6">
          <h2 className="font-serif text-2xl tracking-tight text-ink">
            {t('mobile.planAvailableTitle')}
          </h2>
          <p className="mt-3 text-sm leading-6 text-gray-700">{t('mobile.planAvailableBody')}</p>
        </section>
      </PublicShell>
    );
  }

  return (
    <PublicShell width="wide">
      <PageIntro
        align="center"
        eyebrow={t('pricingPage.eyebrow')}
        title={t(`pricingPage.title.${state}`)}
        lede={t(`pricingPage.lede.${state}`)}
      />

      {PUBLIC_REGISTRATION_AVAILABLE && (
        <div className="mt-8 flex justify-center">
          <Link to="/register" className={buttonStyles({ size: 'lg' })}>
            {t('auth.signUpFree')}
          </Link>
        </div>
      )}

      {/* Trial terms and the purchase path answer the two questions a buyer
          has while looking at the CTA, so they sit with the grid rather than
          only in the FAQ far below. They go through `publishedFooter` so they
          appear only when real amounts do: describing checkout above a
          "payments are temporarily unavailable" notice would contradict it. */}
      <PricingGrid
        publishedFooter={
          <>
            <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-6 text-gray-700">
              {t('pricing.trialNote')}
            </p>
            <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-6 text-gray-600">
              {t('pricing.howToBuyNote')}
            </p>
            <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-6 text-gray-600">
              {t('pricing.giftNote')}{' '}
              <Link to="/gift" className="font-medium text-primary-700 hover:underline">
                {t('giftLanding.navLink')}
              </Link>
              .
            </p>
          </>
        }
      />

      {/* Positioning, not a purchase claim: it explains what paid tiers are
          for, which stays true whether or not checkout is open right now. */}
      {!COMMERCIAL_HOLD_ACTIVE && (
        <>
          <section className="mt-16 mx-auto max-w-4xl">
            <h2 className="font-serif text-2xl tracking-tight text-ink text-center">
              {t('pricing.whyHeading')}
            </h2>
            <ul role="list" className="mt-8 grid gap-6 md:grid-cols-2">
              {WHY_PAID_POINTS.map((point) => (
                <li
                  key={point.title}
                  className="rounded-2xl border border-primary-100 bg-white p-6"
                >
                  <h3 className="font-medium text-gray-900">{t(point.title)}</h3>
                  <p className="mt-2 text-sm leading-6 text-gray-600">{t(point.body)}</p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <section className="mt-16 max-w-2xl mx-auto">
        <h2 className="font-serif text-2xl tracking-tight text-ink">
          {COMMERCIAL_HOLD_ACTIVE ? t('pricingStatus.headingHeld') : t('pricingStatus.headingOpen')}
        </h2>
        <dl className="mt-6 space-y-6">
          {PUBLIC_REGISTRATION_AVAILABLE && (
            <div>
              <dt className="font-medium text-gray-900">
                {t('pricingStatus.freeAccountQuestion')}
              </dt>
              <dd className="mt-1 text-sm text-gray-600">{t('pricingStatus.freeAccountAnswer')}</dd>
            </div>
          )}
          {(COMMERCIAL_HOLD_ACTIVE
            ? (['paidOffer', 'reactivation'] as const)
            : // `household` and `card` lead: "does everyone need to pay?" and
              // "will you take my card?" are the two questions a hesitant
              // buyer has before the ones about changing plans later.
              (['household', 'trial', 'card', 'change', 'where'] as const)
          ).map((topic) => (
            <div key={topic}>
              <dt className="font-medium text-gray-900">{t(`pricingStatus.${topic}Question`)}</dt>
              <dd className="mt-1 text-sm text-gray-600">{t(`pricingStatus.${topic}Answer`)}</dd>
            </div>
          ))}
          <div>
            <dt className="font-medium text-gray-900">{t('pricingStatus.dataQuestion')}</dt>
            <dd className="mt-1 text-sm text-gray-600">
              {COMMERCIAL_HOLD_ACTIVE
                ? t('pricingStatus.dataAnswerHeld')
                : t('pricingStatus.dataAnswerOpen')}
            </dd>
          </div>
        </dl>
      </section>
    </PublicShell>
  );
}
