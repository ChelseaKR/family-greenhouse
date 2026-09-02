import { Link } from 'react-router';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { buttonStyles } from '@/components/buttonStyles';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { PricingGrid } from './PricingGrid';
import { isNativeApp } from '@/lib/platform';
import { useTranslation } from 'react-i18next';
import { PUBLIC_REGISTRATION_AVAILABLE, COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';

/** Standalone public status page retained at /pricing for stable links. */
export function PricingPage() {
  const { t } = useTranslation();
  const native = isNativeApp();
  useMetaTags({
    title: COMMERCIAL_HOLD_ACTIVE
      ? PUBLIC_REGISTRATION_AVAILABLE
        ? 'Free accounts and plan status — Family Greenhouse'
        : 'Plan status — Family Greenhouse'
      : 'Plans and pricing — Family Greenhouse',
    description: COMMERCIAL_HOLD_ACTIVE
      ? PUBLIC_REGISTRATION_AVAILABLE
        ? 'Create a free Family Greenhouse account for up to 10 plants. Paid plans, purchases, and plan changes remain paused.'
        : 'Paid plans, purchases, plan changes, and new account registration are paused.'
      : 'Start free with up to 10 plants, or choose a paid plan for a larger collection. Every paid plan begins with a 14-day trial.',
    canonical: siteUrl('/pricing'),
  });

  if (native) {
    return (
      <PublicShell>
        <PageIntro
          eyebrow="Plan information"
          title="Your Family Greenhouse plan"
          lede="The mobile app does not offer purchases or plan changes. Existing account holders can see current plan status and usage in Settings → Billing, and can change plans on the web."
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
        eyebrow="Plans"
        title={
          COMMERCIAL_HOLD_ACTIVE
            ? PUBLIC_REGISTRATION_AVAILABLE
              ? 'Start with a free account'
              : 'Paid plans are paused'
            : 'Plans for every collection'
        }
        lede={
          COMMERCIAL_HOLD_ACTIVE
            ? PUBLIC_REGISTRATION_AVAILABLE
              ? 'Free accounts include up to 10 plants and 6 household members. Paid plans, purchases, and plan changes remain paused.'
              : 'New account registration, paid plans, purchases, and plan changes are currently paused.'
            : 'Free accounts include up to 10 plants and 6 household members. Paid plans lift those caps and begin with a 14-day trial you can cancel any time.'
        }
      />

      {PUBLIC_REGISTRATION_AVAILABLE && (
        <div className="mt-8 flex justify-center">
          <Link to="/register" className={buttonStyles({ size: 'lg' })}>
            {t('auth.signUpFree')}
          </Link>
        </div>
      )}

      <PricingGrid />

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
            : (['trial', 'change', 'where'] as const)
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
