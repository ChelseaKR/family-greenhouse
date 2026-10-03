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
import { formatContentDate } from '@/utils/contentDate';
import { findCareGuide, type CareGuide } from './careGuides';
import {
  ASPCA_POISON_CONTROL_PHONE,
  careToxicity,
  nameInSentence,
  sentenceName,
  type CareToxicity,
} from './careToxicity';

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

const VERDICT_LABEL = {
  toxic: 'Toxic',
  'non-toxic': 'Non-toxic',
  'not-assessed': 'Unknown',
} as const;

/** US Poison Help line (America's Poison Centers), for people, not pets. */
const POISON_HELP_TEL = 'tel:+18002221222';

/** ASPCA Animal Poison Control Center, as a dialable link. */
const ASPCA_POISON_CONTROL_TEL = `tel:+1${ASPCA_POISON_CONTROL_PHONE.replace(/-/g, '')}`;

/**
 * Pets and people, answered only from the cited table. Each animal's line is
 * a verdict with its ASPCA listing beside it, or "Unknown" with the reason;
 * there is no third, uncited state. People get no verdict at all, because the
 * source does not cover them.
 */
function ToxicitySection({ guide, toxicity }: { guide: CareGuide; toxicity: CareToxicity }) {
  return (
    <section aria-labelledby="pets-and-children" data-testid="care-toxicity">
      <h2 id="pets-and-children">
        Is {nameInSentence(guide.commonName)} safe for pets and children?
      </h2>
      <dl>
        {(['cats', 'dogs'] as const).map((animal) => {
          const claim = toxicity.claims[animal];
          return (
            <div key={animal} className="mt-3">
              <dt className="font-semibold capitalize text-gray-900">{animal}</dt>
              <dd className="mt-1 text-gray-700" data-claim={animal} data-state={claim.state}>
                <strong>{VERDICT_LABEL[claim.state]}.</strong>{' '}
                {claim.state === 'not-assessed' ? (
                  <>Not on the ASPCA’s list for {animal}, so we can’t give a verdict.</>
                ) : (
                  <>
                    Source:{' '}
                    <a
                      href={claim.source.url}
                      className="text-primary-700 underline hover:no-underline"
                      rel="noopener"
                    >
                      ASPCA, {claim.source.title} ({claim.source.scientificName})
                    </a>
                    .
                  </>
                )}
              </dd>
            </div>
          );
        })}
        <div className="mt-3">
          <dt className="font-semibold text-gray-900">People, including children</dt>
          <dd className="mt-1 text-gray-700" data-claim="people" data-state="not-assessed">
            <strong>Not covered by our source.</strong> The ASPCA assesses animals only, so this
            page makes no claim about people. If a child eats part of any houseplant, call Poison
            Help at{' '}
            <a href={POISON_HELP_TEL} className="text-primary-700 underline hover:no-underline">
              1-800-222-1222
            </a>{' '}
            (US).
          </dd>
        </div>
      </dl>
      {toxicity.caution && (
        <p
          data-testid="toxicity-caution"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-gray-900"
        >
          {toxicity.caution}{' '}
          <a
            href={ASPCA_POISON_CONTROL_TEL}
            className="text-primary-700 underline hover:no-underline"
          >
            Call {ASPCA_POISON_CONTROL_PHONE}
          </a>
        </p>
      )}
      {toxicity.note && <p>{toxicity.note}</p>}
      {toxicity.petSafePath && (
        <p>
          <Link to={toxicity.petSafePath} className="text-primary-700 underline hover:no-underline">
            The {sentenceName(guide.commonName)} pet-safety page, with the ASPCA listing
          </Link>
        </p>
      )}
    </section>
  );
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
 * components. Emits Article, FAQPage and BreadcrumbList JSON-LD.
 *
 * FAQPage carries only questions whose answers are printed on the page, and
 * the pet-toxicity question only when every animal's verdict is cited (see
 * careToxicity.ts). Since 2023 Google shows FAQ rich results only for
 * well-known government and health sites, so the markup describes the page
 * rather than buying a rich result; URL Inspection on 2026-10-02 detected
 * only Breadcrumbs on these pages.
 */
export function CareGuidePage() {
  const { slug } = useParams<{ slug: string }>();
  const guide = slug ? findCareGuide(slug) : undefined;
  const toxicity = guide ? careToxicity(guide) : undefined;
  // Every FAQ shown on the page, in order: the guide's care questions, then
  // the generated pet question. Only the sourced ones go into FAQPage.
  const faqs = guide && toxicity ? [...guide.faqs, toxicity.faq] : [];
  const markedUpFaqs = guide && toxicity ? (toxicity.sourced ? faqs : guide.faqs) : [];

  useMetaTags(
    guide
      ? {
          title: guide.metaTitle,
          description: guide.metaDescription,
          canonical: `${SITE}/care/${guide.slug}`,
          ogType: 'article',
          // Only modifiedTime: the guides carry no record of when they first
          // shipped — the repository's history begins at its root commit
          // (2026-07-05) and ten of them are already in it — so there is no
          // honest `publishedTime` to emit.
          article: { modifiedTime: guide.updated, section: 'Plant care' },
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
                // Two dates, two fields, because they answer two questions:
                // `reviewed` is when the facts were last checked, `updated`
                // is when the page last changed. Publishing `reviewed` as
                // both left six guides claiming a `dateModified` 80 days
                // older than their own content (see careGuides.ts).
                datePublished: guide.reviewed,
                dateModified: guide.updated,
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
                // An unsourced pet answer is shown to readers but never
                // published as structured data (see careToxicity.ts).
                mainEntity: markedUpFaqs.map((f) => ({
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

  if (!guide || !toxicity) {
    return <Navigate to="/care" replace />;
  }

  // Curated per guide (`related` in careGuides.ts): the plant people confuse
  // it with, or the one that suits the same spot. This replaced a rotation
  // through the array, which spread links evenly but paired plants at random.
  const related = guide.related
    .map((relatedSlug) => findCareGuide(relatedSlug))
    .filter((g): g is CareGuide => g !== undefined);

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
                [
                  'Toxic to pets?',
                  toxicity.sourced
                    ? `${guide.quickFacts.toxicity} (source: ASPCA)`
                    : guide.quickFacts.toxicity,
                  PawLeafIcon,
                ],
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
        <h2>How often to water {nameInSentence(guide.commonName)}</h2>
        <Paragraphs items={guide.sections.watering} />

        <h2>Light and humidity</h2>
        <Paragraphs items={guide.sections.light} />
        <p>
          <strong>Humidity:</strong> {guide.quickFacts.humidity}.
        </p>

        <h2>Why is my {sentenceName(guide.commonName)} dying?</h2>
        <Paragraphs items={guide.sections.problems} />

        <h2>How to propagate {nameInSentence(guide.commonName)}</h2>
        <Paragraphs items={guide.sections.propagation} />

        <ToxicitySection guide={guide} toxicity={toxicity} />

        <h2>Keeping it alive when you share a home</h2>
        <Paragraphs items={guide.sections.sharedCare} />
        <p>
          {withLinks(
            'If you use Family Greenhouse for this, [sharing plants with a household](/help/households) explains who sees what and who gets reminded.'
          )}
        </p>

        <h2>The honest bit</h2>
        <Paragraphs items={guide.sections.honestBit} />

        <h2>{guide.commonName} FAQ</h2>
        <dl>
          {faqs.map((f) => (
            <div key={f.q} className="mt-4">
              <dt className="font-semibold text-gray-900">{f.q}</dt>
              <dd className="mt-1 text-gray-700">{withLinks(f.a)}</dd>
            </div>
          ))}
        </dl>
      </article>

      {/* The page's own copy of the dates its markup publishes. Without this
          the guides emitted `dateModified` and `article:modified_time` while
          showing the reader no date at all — a claim only a machine could
          see, and one nobody proofreading the page could catch going stale.
          Both <time> values are the literals fed to the JSON-LD above. */}
      <p className="mt-10 text-sm text-gray-600">
        Facts last reviewed{' '}
        <time dateTime={guide.reviewed}>{formatContentDate(guide.reviewed)}</time>
        {guide.updated !== guide.reviewed && (
          <>
            {' '}
            · page last updated{' '}
            <time dateTime={guide.updated}>{formatContentDate(guide.updated)}</time>
          </>
        )}
      </p>

      {PUBLIC_REGISTRATION_AVAILABLE && (
        <aside className="mt-16 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
          <p className="font-serif text-xl text-ink">Stop guessing when you watered it</p>
          <p className="mt-2 text-sm text-gray-600">
            Family Greenhouse tracks your {sentenceName(guide.commonName)}’s schedule and reminds
            the right person — so “I thought you watered it” stops being a thing. Free for up to 20
            plants, no card.
          </p>
          <div className="mt-4">
            <Link to="/register" className={buttonStyles()}>
              Add your {sentenceName(guide.commonName)}
            </Link>
          </div>
        </aside>
      )}

      {related.length > 0 && (
        <section className="mt-16">
          <h2 className="font-serif text-2xl tracking-tight text-ink">Related plants</h2>
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
