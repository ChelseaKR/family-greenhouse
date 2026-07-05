import { PublicShell, PageIntro } from '@/components/PublicShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { PricingGrid } from './PricingGrid';

/**
 * Standalone /pricing page. Same content as the LandingPage anchor
 * section but with its own URL, meta tags, and chrome — better for SEO
 * (a real page targeting "family greenhouse pricing" or "shared plant
 * care app cost") and for paid-funnel landing where we want to drop
 * users straight into the pricing decision.
 */
export function PricingPage() {
  useMetaTags({
    title: 'Pricing — Family Greenhouse',
    description:
      'Family Greenhouse pricing: free for up to 10 plants, paid plans for larger households and households that want care analytics, API access, and unlimited plants.',
    canonical: siteUrl('/pricing'),
  });

  return (
    <PublicShell width="wide">
      <PageIntro
        align="center"
        eyebrow="Pricing"
        title="Plans for every greenhouse"
        lede="Start free. Upgrade when your household outgrows it. Cancel any time from inside the app."
      />

      <PricingGrid />

      <section className="mt-16 max-w-2xl mx-auto">
        <h2 className="font-serif text-2xl tracking-tight text-ink">Common questions</h2>
        <dl className="mt-6 space-y-6">
          <div>
            <dt className="font-medium text-gray-900">
              Do I need a credit card to try the free plan?
            </dt>
            <dd className="mt-1 text-sm text-gray-600">
              No. The Seedling plan is fully free, no card required. Add up to 10 plants and bring
              in up to 6 household members.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-900">
              What happens if I downgrade past my plant or member limit?
            </dt>
            <dd className="mt-1 text-sm text-gray-600">
              Existing plants and members stay — we never auto-delete data. You won&rsquo;t be able
              to add new ones until you&rsquo;re back under the cap. Active tasks keep running.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-900">
              Can I share a single subscription across multiple households?
            </dt>
            <dd className="mt-1 text-sm text-gray-600">
              A subscription pays for one household. If you create a second household (a vacation
              place, a parent&rsquo;s plants), the new household starts on the free Seedling plan
              and can be upgraded independently.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-900">
              What does &ldquo;API access&rdquo; mean on the Greenhouse plan?
            </dt>
            <dd className="mt-1 text-sm text-gray-600">
              Read-only access to your household data over a versioned REST API, authenticated with
              personal access keys you can mint and revoke from Settings. Useful for Home Assistant
              integrations, personal scripts, and exporting to other tools.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-900">How do refunds work?</dt>
            <dd className="mt-1 text-sm text-gray-600">
              Monthly subscriptions aren&rsquo;t pro-rated on cancel. If you&rsquo;ve been billed by
              mistake or the service was seriously broken for you, email us — we&rsquo;ll make it
              right.
            </dd>
          </div>
        </dl>
      </section>
    </PublicShell>
  );
}
