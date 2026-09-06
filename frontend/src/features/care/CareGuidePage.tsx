import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { PublicShell } from '@/components/PublicShell';
import { buttonStyles } from '@/components/buttonStyles';
import { WaterDropIcon } from '@/components/icons/WaterDropIcon';
import { SunGlowIcon } from '@/components/icons/SunGlowIcon';
import { GrowthRingsIcon } from '@/components/icons/GrowthRingsIcon';
import { MistLeafIcon } from '@/components/icons/MistLeafIcon';
import { PawLeafIcon } from '@/components/icons/PawLeafIcon';
import { useMetaTags } from '@/hooks/useMetaTags';
import { SITE_URL } from '@/config/site';
import { DEFAULT_OG_IMAGE } from '@/config/seo';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { CARE_GUIDES, findCareGuide, type CareGuide } from './careGuides';

const SITE = SITE_URL;

/**
 * Minimal inline-link syntax for guide prose: `[text](/path)`, internal paths
 * only. Deliberately not a markdown parser — `careGuides.ts` sections and FAQ
 * answers are `string`, rendered as `{text}` into JSX, so anything richer
 * would mean either a markdown runtime or `dangerouslySetInnerHTML`, and the
 * copy needs exactly one construct.
 *
 * Why it exists: twelve places in careGuides.ts wrote "the free pet-safe
 * checker at /pet-safe", and with no parser the reader saw the literal
 * characters `/pet-safe` mid-sentence. The copy said "link" and the DOM had
 * no anchor, so /pet-safe — the highest-intent page on the site — got zero
 * inbound links from the 24 pages most likely to send it traffic.
 *
 * Paths only, never absolute URLs: an external href would need rel/target
 * handling and a trust decision, and none of this copy wants one.
 */
const INLINE_LINK = /\[([^\]]+)\]\((\/[A-Za-z0-9\-._~/]*)\)/g;

function withLinks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_LINK)) {
    const at = match.index;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <Link key={at} to={match[2]!} className="text-primary-700 underline hover:no-underline">
        {match[1]}
      </Link>
    );
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The same prose with the link syntax removed, for places that need plain
 * text rather than nodes — notably the FAQPage JSON-LD, which must publish
 * the sentence a reader sees and not `[free pet-safe checker](/pet-safe)`.
 */
function plainText(text: string): string {
  return text.replace(INLINE_LINK, '$1');
}

function Paragraphs({ items }: { items: string[] }) {
  return (
    <>
      {items.map((p, i) => (
        <p key={i}>{withLinks(p)}</p>
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
                // Was "<Name> Care Guide" while the visible H1 reads
                // "<Name> care" and the metaTitle a third thing. Google asks
                // that headline match the visible headline.
                headline: `${guide.commonName} care`,
                description: guide.metaDescription,
                // See the note in BlogPost.tsx — `image` is required for the
                // Article rich result and all 24 guides omitted it.
                image: {
                  '@type': 'ImageObject',
                  url: DEFAULT_OG_IMAGE,
                  width: 1200,
                  height: 630,
                },
                datePublished: guide.reviewed,
                dateModified: guide.reviewed,
                author: { '@type': 'Organization', name: 'Family Greenhouse' },
                publisher: {
                  '@type': 'Organization',
                  '@id': `${SITE}/#organization`,
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
                  acceptedAnswer: { '@type': 'Answer', text: plainText(f.a) },
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

  // Rotate from this guide's own position rather than slicing the front of
  // the array. `.slice(0, 3)` took the first three entries every time, so all
  // 24 guides linked to pothos / snake-plant / monstera — those three
  // collected 23 sibling links each and the other 20 collected none, leaving
  // them with a single inbound link site-wide (the /care index). Rotation
  // spreads the same 72 links three-per-guide with no manual curation.
  //
  // It buys distribution, not topical relevance: the real win is a curated
  // `relatedSlugs` on CareGuide (pothos <-> heartleaf-philodendron, the two
  // people constantly confuse; snake-plant <-> zz-plant, the unkillable
  // pair). That is content work; this is the mechanical half.
  const relatedCount = Math.min(3, CARE_GUIDES.length - 1);
  const guideIndex = CARE_GUIDES.findIndex((g) => g.slug === guide.slug);
  const related = Array.from(
    { length: relatedCount },
    (_, i) => CARE_GUIDES[(guideIndex + 1 + i) % CARE_GUIDES.length]
  ).filter((g) => g !== undefined);

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
              <dd className="mt-1 text-gray-700">{withLinks(f.a)}</dd>
            </div>
          ))}
        </dl>
      </article>

      {PUBLIC_REGISTRATION_AVAILABLE && (
        <aside className="mt-16 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
          <p className="font-serif text-xl text-ink">Stop guessing when you watered it</p>
          <p className="mt-2 text-sm text-gray-600">
            Family Greenhouse tracks your {guide.commonName.toLowerCase()}’s schedule and reminds
            the right person — so “I thought you watered it” stops being a thing. Free for up to 20
            plants, no card.
          </p>
          <div className="mt-4">
            <Link to="/register" className={buttonStyles()}>
              Add your {guide.commonName.toLowerCase()}
            </Link>
          </div>
        </aside>
      )}

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
