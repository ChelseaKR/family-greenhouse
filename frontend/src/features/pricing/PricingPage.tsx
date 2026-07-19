import { Link } from 'react-router-dom';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { buttonStyles } from '@/components/buttonStyles';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { PricingGrid } from './PricingGrid';
import { isNativeApp } from '@/lib/platform';
import { useTranslation } from 'react-i18next';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';

/** Standalone public status page retained at /pricing for stable links. */
export function PricingPage() {
  const { t } = useTranslation();
  const native = isNativeApp();
  useMetaTags({
    title: PUBLIC_REGISTRATION_AVAILABLE
      ? 'Free accounts and plan status — Family Greenhouse'
      : 'Plan status — Family Greenhouse',
    description: PUBLIC_REGISTRATION_AVAILABLE
      ? 'Create a free Family Greenhouse account for up to 10 plants. Paid plans, purchases, and plan changes remain paused.'
      : 'Paid plans, purchases, plan changes, and new account registration are paused.',
    canonical: siteUrl('/pricing'),
  });

  if (native) {
    return (
      <PublicShell>
        <PageIntro
          eyebrow="Plan information"
          title="Your Family Greenhouse plan"
          lede="The mobile app does not offer purchases or plan changes. Existing account holders can see current plan status and usage in Settings → Billing."
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
          PUBLIC_REGISTRATION_AVAILABLE ? 'Start with a free account' : 'Paid plans are paused'
        }
        lede={
          PUBLIC_REGISTRATION_AVAILABLE
            ? 'Free accounts include up to 10 plants and 6 household members. Paid plans, purchases, and plan changes remain paused.'
            : 'New account registration, paid plans, purchases, and plan changes are currently paused.'
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
        <h2 className="font-serif text-2xl tracking-tight text-ink">What remains available</h2>
        <dl className="mt-6 space-y-6">
          {PUBLIC_REGISTRATION_AVAILABLE && (
            <div>
              <dt className="font-medium text-gray-900">
                {t('pricingStatus.freeAccountQuestion')}
              </dt>
              <dd className="mt-1 text-sm text-gray-600">{t('pricingStatus.freeAccountAnswer')}</dd>
            </div>
          )}
          <div>
            <dt className="font-medium text-gray-900">Is this a paid offer?</dt>
            <dd className="mt-1 text-sm text-gray-600">
              No. Free accounts are available, but the hosted site does not currently accept
              purchases or offer paid plans.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-900">What happens to existing data?</dt>
            <dd className="mt-1 text-sm text-gray-600">
              Existing plants, household records, tasks, and care history remain available under the
              current plan limits. The hold does not delete user data.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-900">Can billing be reactivated automatically?</dt>
            <dd className="mt-1 text-sm text-gray-600">
              No. Reactivation requires a dated status decision, reviewed source and infrastructure
              changes, non-production verification, and a separately approved deployment.
            </dd>
          </div>
        </dl>
      </section>
    </PublicShell>
  );
}
