import { PublicShell, PageIntro } from '@/components/PublicShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { PricingGrid } from './PricingGrid';
import { isNativeApp } from '@/lib/platform';
import { useTranslation } from 'react-i18next';

/** Standalone public status page retained at /pricing for stable links. */
export function PricingPage() {
  const { t } = useTranslation();
  const native = isNativeApp();
  useMetaTags({
    title: 'Demo status — Family Greenhouse',
    description:
      'Family Greenhouse is available as a technical demonstration. New account registration, paid plans, purchases, and plan changes are paused.',
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
        eyebrow="Demo status"
        title="Commercial activity is paused"
        lede="This page preserves a stable link while new account registration, pricing, purchases, and plan changes are unavailable."
      />

      <PricingGrid />

      <section className="mt-16 max-w-2xl mx-auto">
        <h2 className="font-serif text-2xl tracking-tight text-ink">What remains available</h2>
        <dl className="mt-6 space-y-6">
          <div>
            <dt className="font-medium text-gray-900">Is this a paid offer?</dt>
            <dd className="mt-1 text-sm text-gray-600">
              No. The hosted site is a technical demonstration and does not currently accept
              purchases or offer paid plans.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-900">What happens to existing data?</dt>
            <dd className="mt-1 text-sm text-gray-600">
              Existing plants, household records, tasks, and care history remain available under the
              project&rsquo;s current demo limits. The hold does not delete user data.
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
