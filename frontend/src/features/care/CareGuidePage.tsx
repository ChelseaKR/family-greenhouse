import { Link, Navigate, useParams } from 'react-router-dom';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { PublicShell } from '@/components/PublicShell';
import { Button } from '@/components/Button';
import { WaterDropIcon } from '@/components/icons/WaterDropIcon';
import { SunGlowIcon } from '@/components/icons/SunGlowIcon';
import { GrowthRingsIcon } from '@/components/icons/GrowthRingsIcon';
import { MistLeafIcon } from '@/components/icons/MistLeafIcon';
import { PawLeafIcon } from '@/components/icons/PawLeafIcon';
import { useMetaTags } from '@/hooks/useMetaTags';
import { SITE_URL } from '@/config/site';
import { CARE_GUIDES, findCareGuide, type CareGuide } from './careGuides';

const SITE = SITE_URL;

function Paragraphs({ items }: { items: string[] }) {
  return (
    <>
      {items.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );
}

/**
 * One template renders every species care page (`/care/:slug`). The content
 * is data (`careGuides.ts`), so the SEO surface scales by adding entries, not
 * components. Emits Article + FAQPage JSON-LD so pages are eligible for
 * Google's article and FAQ rich results — the FAQ markup is the highest-ROI
 * schema for these queries because "how often to water X" is a voice/quick
 * answer pattern.
 */
export function CareGuidePage() {
  const { slug } = useParams<{ slug: string }>();
  const guide = slug ? findCareGuide(slug) : undefined;

  useMetaTags(
    guide
      ? {
          title: guide.metaTitle,
          description: guide.metaDescription,
          canonical: `${SITE}/care/${guide.slug}`,
          ogType: 'article',
          jsonLd: {
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'Article',
                headline: `${guide.commonName} Care Guide`,
                description: guide.metaDescription,
                datePublished: guide.reviewed,
                dateModified: guide.reviewed,
                author: { '@type': 'Organization', name: 'Family Greenhouse' },
                publisher: {
                  '@type': 'Organization',
                  name: 'Family Greenhouse',
                  logo: {
                    '@type': 'ImageObject',
                    url: `${SITE}/brand/icon-512.png`,
                  },
                },
                mainEntityOfPage: {
                  '@type': 'WebPage',
                  '@id': `${SITE}/care/${guide.slug}`,
                },
                about: {
                  '@type': 'Thing',
                  name: guide.commonName,
                  alternateName: [guide.scientificName, ...guide.alsoKnownAs],
                },
              },
              {
                '@type': 'FAQPage',
                mainEntity: guide.faqs.map((f) => ({
                  '@type': 'Question',
                  name: f.q,
                  acceptedAnswer: { '@type': 'Answer', text: f.a },
                })),
              },
              {
                '@type': 'BreadcrumbList',
                itemListElement: [
                  { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
                  { '@type': 'ListItem', position: 2, name: 'Plant care', item: `${SITE}/care` },
                  { '@type': 'ListItem', position: 3, name: `${guide.commonName} care` },
                ],
              },
            ],
          },
        }
      : {}
  );

  if (!guide) {
    return <Navigate to="/care" replace />;
  }

  const related = CARE_GUIDES.filter((g) => g.slug !== guide.slug).slice(0, 3);

  return (
    <PublicShell width="article">
      <Link
        to="/care"
        className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        All care guides
      </Link>

      <header className="mt-6 mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-700">
          Plant care guide
        </p>
        <h1 className="mt-3 font-serif text-4xl tracking-tight text-ink sm:text-5xl">
          {guide.commonName} care
        </h1>
        <p className="mt-2 text-lg italic text-gray-600">
          {guide.scientificName}
          {guide.alsoKnownAs.length > 0 && (
            <span className="not-italic text-base text-gray-600">
              {' '}
              · also called {guide.alsoKnownAs.join(', ')}
            </span>
          )}
        </p>
      </header>

      <p className="prose-fg lead">{guide.summary}</p>

      {/* At-a-glance facts, styled as the back of a seed packet:
            parchment ground, a dashed inner frame like a cut line, and a
            hand-drawn icon per fact. The icons mark topics only — the
            fact text carries the actual answer. */}
      <aside
        aria-label={`${guide.commonName} at a glance`}
        className="mt-8 rounded-xl border border-primary-200 bg-parchment/70 shadow-journal"
      >
        <div className="m-2 rounded-lg border border-dashed border-primary-300/70 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-800">
            At a glance
          </p>
          <dl className="mt-1 divide-y divide-primary-200/50">
            {(
              [
                ['Water', guide.quickFacts.water, WaterDropIcon],
                ['Light', guide.quickFacts.light, SunGlowIcon],
                ['Difficulty', guide.quickFacts.difficulty, GrowthRingsIcon],
                ['Humidity', guide.quickFacts.humidity, MistLeafIcon],
                ['Toxic to pets?', guide.quickFacts.toxicity, PawLeafIcon],
              ] as Array<[string, string, React.ComponentType<{ className?: string }>]>
            ).map(([label, value, Icon]) => (
              <div key={label} className="flex gap-4 py-3">
                <Icon className="mt-0.5 h-8 w-8 shrink-0 text-primary-700" />
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-primary-800">
                    {label}
                  </dt>
                  <dd className="mt-0.5 text-sm text-gray-900">{value}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>
      </aside>

      <article className="prose-fg mt-12">
        <h2>How often to water a {guide.commonName.toLowerCase()}</h2>
        <Paragraphs items={guide.sections.watering} />

        <h2>Light</h2>
        <Paragraphs items={guide.sections.light} />

        <h2>Why is my {guide.commonName.toLowerCase()} dying?</h2>
        <Paragraphs items={guide.sections.problems} />

        <h2>Keeping it alive when you share a home</h2>
        <Paragraphs items={guide.sections.sharedCare} />

        <h2>The honest bit</h2>
        <Paragraphs items={guide.sections.honestBit} />

        <h2>{guide.commonName} FAQ</h2>
        <dl>
          {guide.faqs.map((f) => (
            <div key={f.q} className="mt-4">
              <dt className="font-semibold text-gray-900">{f.q}</dt>
              <dd className="mt-1 text-gray-700">{f.a}</dd>
            </div>
          ))}
        </dl>
      </article>

      <aside className="mt-16 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
        <p className="font-serif text-xl text-ink">Stop guessing when you watered it</p>
        <p className="mt-2 text-sm text-gray-600">
          Family Greenhouse tracks your {guide.commonName.toLowerCase()}’s schedule and reminds the
          right person — so “I thought you watered it” stops being a thing. Free for up to 10
          plants, no card.
        </p>
        <div className="mt-4">
          <Link to="/register">
            <Button>Add your {guide.commonName.toLowerCase()}</Button>
          </Link>
        </div>
      </aside>

      {related.length > 0 && (
        <section className="mt-16">
          <h2 className="font-serif text-2xl tracking-tight text-ink">More care guides</h2>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {related.map((g) => (
              <li key={g.slug}>
                <Link
                  to={`/care/${g.slug}`}
                  className="group block h-full rounded-xl border border-primary-100/80 bg-white p-4 shadow-journal transition hover:border-primary-300 hover:shadow-journal-hover"
                >
                  <span className="font-serif text-lg text-ink group-hover:text-primary-700">
                    {g.commonName}
                  </span>
                  <span className="mt-1 block text-xs text-gray-600">{g.quickFacts.water}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PublicShell>
  );
}

export type { CareGuide };
