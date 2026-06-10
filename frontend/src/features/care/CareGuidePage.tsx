import { Link, Navigate, useParams } from 'react-router-dom';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { BrandMark } from '@/components/BrandMark';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/Button';
import { useMetaTags } from '@/hooks/useMetaTags';
import { CARE_GUIDES, findCareGuide, type CareGuide } from './careGuides';

const SITE = 'https://app.familygreenhouse.com';

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
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-gray-200">
        <nav className="mx-auto max-w-3xl flex items-center justify-between p-6">
          <Link to="/" aria-label="Family Greenhouse home">
            <BrandMark variant="wordmark" size="sm" />
          </Link>
          <Link to="/" className="text-sm font-medium text-primary-700 hover:underline">
            Try the app →
          </Link>
        </nav>
      </header>

      <main className="flex-1 mx-auto max-w-2xl w-full px-6 py-12 sm:py-16">
        <Link
          to="/care"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
        >
          <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
          All care guides
        </Link>

        <header className="mt-6 mb-8">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary-700">
            Plant care guide
          </p>
          <h1 className="mt-3 font-serif text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
            {guide.commonName} care
          </h1>
          <p className="mt-2 text-lg italic text-gray-500">
            {guide.scientificName}
            {guide.alsoKnownAs.length > 0 && (
              <span className="not-italic text-base text-gray-400">
                {' '}
                · also called {guide.alsoKnownAs.join(', ')}
              </span>
            )}
          </p>
        </header>

        <p className="prose-fg lead">{guide.summary}</p>

        {/* At-a-glance grounded facts */}
        <dl className="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-primary-100 bg-primary-100 sm:grid-cols-2">
          {[
            ['Water', guide.quickFacts.water],
            ['Light', guide.quickFacts.light],
            ['Difficulty', guide.quickFacts.difficulty],
            ['Humidity', guide.quickFacts.humidity],
            ['Toxic to pets?', guide.quickFacts.toxicity],
          ].map(([label, value]) => (
            <div key={label} className="bg-white p-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-primary-700">
                {label}
              </dt>
              <dd className="mt-1 text-sm text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>

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

        <aside className="mt-16 rounded-lg border border-primary-200 bg-primary-50 p-6 text-center">
          <p className="font-serif text-xl font-semibold text-gray-900">
            Stop guessing when you watered it
          </p>
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
            <h2 className="font-serif text-2xl font-semibold tracking-tight text-gray-900">
              More care guides
            </h2>
            <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {related.map((g) => (
                <li key={g.slug}>
                  <Link
                    to={`/care/${g.slug}`}
                    className="group block rounded-lg border border-primary-100 p-4 transition-colors hover:border-primary-300 hover:bg-primary-50/50"
                  >
                    <span className="font-serif text-lg font-semibold text-gray-900 group-hover:text-primary-700">
                      {g.commonName}
                    </span>
                    <span className="mt-1 block text-xs text-gray-500">{g.quickFacts.water}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <Footer />
    </div>
  );
}

export type { CareGuide };
