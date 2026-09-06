import { useEffect, useState } from 'react';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { Alert } from '@/components/Alert';
import { Input } from '@/components/Input';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl, SITE_URL } from '@/config/site';
import { useDebounce } from '@/hooks/useDebounce';
import { petToxicityService, type ToxicityMatch } from '@/services/petToxicityService';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import {
  PET_SAFE_GROUPS,
  PET_SAFE_SPECIES,
  PET_SAFETY_POSTS,
  type PetSafeGroupId,
  type PetSafetyLevel,
} from './petSafeSpecies';

const PAGE_TITLE = 'Is This Plant Safe for Pets? — Cat & Dog Toxicity Checker';
const PAGE_DESCRIPTION =
  'Free, no-signup checker: type a houseplant name and see whether it’s toxic to cats and dogs, in plain language. Based on the ASPCA’s plant safety data.';

/**
 * `CollectionPage`, not `WebApplication`.
 *
 * The tool is genuinely a free, no-signup web app, and `WebApplication` is a
 * defensible reading of the search form. But what this page now IS, to a
 * crawler, is a directory: 24 species, each with a verdict, each linking the
 * guide that owns it. `CollectionPage` + `ItemList` describes exactly that and
 * is the type Google's list handling understands. `WebApplication` would
 * instead announce a software entity — a class of result that wants
 * `offers`, `applicationCategory` and ratings we do not have here, and one the
 * site already publishes properly once, as the `SoftwareApplication` node on
 * the landing page (`LandingPage.tsx`). Claiming it a second time on a
 * subpage would compete with that node rather than describe this content.
 */
const PET_SAFE_JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'CollectionPage',
      '@id': siteUrl('/pet-safe'),
      url: siteUrl('/pet-safe'),
      name: PAGE_TITLE,
      description: PAGE_DESCRIPTION,
      inLanguage: 'en',
      isPartOf: {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: 'Family Greenhouse',
        url: SITE_URL,
      },
      about: {
        '@type': 'Thing',
        name: 'Houseplant toxicity in cats and dogs',
      },
      mainEntity: { '@id': siteUrl('/pet-safe#species') },
    },
    {
      '@type': 'ItemList',
      '@id': siteUrl('/pet-safe#species'),
      name: 'Houseplants checked for cat and dog toxicity',
      numberOfItems: PET_SAFE_SPECIES.length,
      // `description` is the care guide's own toxicity line, unedited —
      // the same string the visible list shows. Structured data and page
      // must not be able to disagree about a pet-safety verdict.
      itemListElement: PET_SAFE_SPECIES.map((species, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: species.commonName,
        description: species.verdict,
        url: siteUrl(`/care/${species.slug}`),
      })),
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl('/') },
        { '@type': 'ListItem', position: 2, name: 'Pet-safe' },
      ],
    },
  ],
};

const GROUP_HEADING: Record<PetSafeGroupId, string> = {
  safe: 'petSafeSpecies.safeHeading',
  unsafe: 'petSafeSpecies.unsafeHeading',
  unclear: 'petSafeSpecies.unclearHeading',
};

const BADGE_LABEL: Record<PetSafetyLevel, string> = {
  safe: 'petSafeSpecies.badgeSafe',
  caution: 'petSafeSpecies.badgeCaution',
  toxic: 'petSafeSpecies.badgeToxic',
  unclear: 'petSafeSpecies.badgeUnclear',
};

/** Colour is a second signal here, never the only one — the badge carries the
 *  word, and the guide's own sentence sits directly under it. */
const BADGE_STYLE: Record<PetSafetyLevel, string> = {
  safe: 'bg-primary-100 text-primary-800 ring-primary-200/60',
  caution: 'bg-amber-50 text-amber-900 ring-amber-300/70',
  toxic: 'bg-red-50 text-red-800 ring-red-200/70',
  unclear: 'bg-gray-100 text-gray-800 ring-gray-300/70',
};

/**
 * Free, no-signup "Is this plant safe for pets?" checker. A top-of-funnel
 * marketing page (public, no auth — like /care and /blog) that answers
 * high-intent "is X toxic to cats/dogs" searches and gently funnels visitors
 * into the app.
 *
 * Toxicity comes from the public, cache-friendly GET /species/toxicity
 * endpoint, which resolves a hand-curated, ASPCA-grounded table server-side.
 * No PII, no auth, read-only.
 *
 * That lookup is a runtime effect, so for a crawler this page was ~187 words
 * of search form and none of the answers it exists to give. `SpeciesDirectory`
 * below is the static counterweight: 24 species with their care guides'
 * own toxicity lines, rendered from bundled data with no fetch and behind no
 * flag, plus CollectionPage/ItemList/BreadcrumbList JSON-LD. The interactive
 * checker is untouched — the list is additive.
 */
export function PetSafePage() {
  const { t } = useTranslation();
  useMetaTags({
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    canonical: siteUrl('/pet-safe'),
    jsonLd: PET_SAFE_JSON_LD,
  });

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), 300);
  const [results, setResults] = useState<ToxicityMatch[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  // Remember the query the current results belong to, so the "no matches"
  // message only shows once a real lookup has settled (not mid-type).
  const [resolvedQuery, setResolvedQuery] = useState('');

  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setResults([]);
      setStatus('idle');
      setResolvedQuery('');
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    petToxicityService
      .lookup(debouncedQuery, controller.signal)
      .then((matches) => {
        setResults(matches);
        setResolvedQuery(debouncedQuery);
        setStatus('done');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  const showEmpty = status === 'done' && results.length === 0 && resolvedQuery.length >= 2;

  return (
    <PublicShell>
      <PageIntro
        eyebrow="Pet safety"
        title="Is this plant safe for pets?"
        lede={
          <>
            Type a houseplant name and we’ll tell you, plainly, whether it’s toxic to cats and dogs.
            No sign-up, no fuss. Based on the{' '}
            <a
              href="https://www.aspca.org/pet-care/animal-poison-control/toxic-and-non-toxic-plants"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-700 underline hover:text-primary-800"
            >
              ASPCA’s plant safety data
            </a>
            .
          </>
        }
      />

      <form
        className="mt-10"
        role="search"
        aria-label="Search plant pet-toxicity"
        onSubmit={(e) => e.preventDefault()}
      >
        <Input
          type="search"
          label="Plant or species name"
          placeholder="e.g. snake plant, pothos, lily…"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          helperText="Try a common name or a scientific name."
        />
      </form>

      {/* Live region so screen readers hear the result as it loads. Every
          child passes `live="off"`: this is a debounced search-as-you-type
          surface, so an Alert that declares its own region here would announce
          a second time per keystroke, and an assertive one would interrupt the
          polite announcement this wrapper exists to make. */}
      <div className="mt-8 space-y-4" aria-live="polite" aria-busy={status === 'loading'}>
        {status === 'error' && (
          <Alert variant="error" title="Something went wrong" live="off">
            We couldn’t check that just now. Give it another moment and try again.
          </Alert>
        )}

        {results.map((match) => (
          <ToxicityCard key={match.slug} match={match} />
        ))}

        {showEmpty && (
          <Alert variant="info" title="No match yet" live="off">
            We don’t have that one in our checker yet. Double-check the spelling, or try the plant’s
            common name. When in doubt, assume it’s unsafe and keep it out of reach until you can
            confirm with your vet or the ASPCA.
          </Alert>
        )}
      </div>

      {/* General, always-visible caveat for kids and pets. */}
      <aside className="mt-12 rounded-xl border border-primary-200 bg-primary-50/60 p-5">
        <h2 className="font-serif text-lg text-ink">A note on kids and pets</h2>
        <p className="mt-2 text-sm text-gray-700">
          Even “non-toxic” plants can cause a mild upset stomach if a curious pet or toddler eats a
          big mouthful — non-toxic means not poisonous, not that it’s food. With anything truly
          toxic, the safest move is height: put it where paws and little hands can’t reach. If you
          think a pet has eaten something harmful, call your vet or the{' '}
          <a
            href="https://www.aspca.org/pet-care/animal-poison-control"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-700 underline hover:text-primary-800"
          >
            ASPCA Animal Poison Control
          </a>{' '}
          line right away.
        </p>
      </aside>

      <SpeciesDirectory />

      {PUBLIC_REGISTRATION_AVAILABLE && (
        <section className="mt-16 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
          <h2 className="font-serif text-xl text-ink">{t('petSafeSignup.title')}</h2>
          <p className="mt-2 text-sm text-gray-600">{t('petSafeSignup.body')}</p>
          <div className="mt-4">
            <Link
              to="/register"
              className="inline-flex items-center rounded-md bg-primary-700 px-4 py-2 text-sm font-medium text-white hover:bg-primary-800 min-h-touch"
            >
              {t('petSafeSignup.cta')}
            </Link>
            <p className="mt-3 text-xs text-gray-600">
              {t('petSafeSignup.browsePrompt')}{' '}
              <Link to="/care" className="text-primary-700 underline hover:text-primary-800">
                {t('petSafeSignup.careGuides')}
              </Link>
              .
            </p>
          </div>
        </section>
      )}
    </PublicShell>
  );
}

/**
 * The crawlable half of the page, and the reason `/pet-safe` can carry its
 * sitemap priority: 24 species, each with the pet-safety line from its own
 * care guide and a link to that guide.
 *
 * Three constraints, all deliberate:
 *
 *  - It renders unconditionally. The page's only internal links used to sit
 *    inside `PUBLIC_REGISTRATION_AVAILABLE &&`, so with registration closed a
 *    logged-out crawler saw a hub with no spokes at all. Whether accounts are
 *    open has nothing to do with whether a pothos is toxic.
 *  - It takes no fetch. The checker answers from `GET /species/toxicity` in an
 *    effect, and effects do not run during `scripts/prerender.mjs`, so
 *    everything the runtime lookup produces is invisible in the static HTML.
 *    This list is rendered from bundled data during render, so it is there.
 *  - The verdict text is the guide's own sentence, verbatim (see
 *    `petSafeSpecies.ts`). Nothing here paraphrases a toxicity answer.
 */
function SpeciesDirectory() {
  const { t } = useTranslation();

  return (
    <>
      <section className="mt-16" aria-labelledby="pet-safe-species-heading">
        <h2
          id="pet-safe-species-heading"
          className="font-serif text-2xl tracking-tight text-ink sm:text-3xl"
        >
          {t('petSafeSpecies.title')}
        </h2>
        <p className="mt-2 text-sm text-gray-700">{t('petSafeSpecies.lede')}</p>

        {PET_SAFE_GROUPS.map((group) => (
          <div key={group.id} className="mt-10">
            <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-800">
              {t(GROUP_HEADING[group.id])}
            </h3>
            <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {group.species.map((species) => (
                <li key={species.slug}>
                  <Link
                    to={`/care/${species.slug}`}
                    className="group block h-full rounded-xl border border-primary-100/80 bg-white p-4 shadow-journal transition hover:border-primary-300 hover:shadow-journal-hover"
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="font-serif text-lg text-ink group-hover:text-primary-700">
                        {species.commonName}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${BADGE_STYLE[species.level]}`}
                      >
                        {t(BADGE_LABEL[species.level])}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs italic text-gray-600">
                      {species.scientificName}
                    </span>
                    <span className="mt-2 block text-sm text-gray-700">{species.verdict}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <p className="mt-8 text-sm">
          <Link to="/care" className="text-primary-700 underline hover:text-primary-800">
            {t('petSafeSpecies.allGuides')}
          </Link>
        </p>
      </section>

      {/* The two posts that answer the question after this one — "so what do I
          buy instead?" — and the only two long-form pet-safety pages we have.
          Neither was linked from here. */}
      <section className="mt-12" aria-labelledby="pet-safe-reading-heading">
        <h2
          id="pet-safe-reading-heading"
          className="font-serif text-xl tracking-tight text-ink sm:text-2xl"
        >
          {t('petSafeSpecies.readingHeading')}
        </h2>
        <ul className="mt-4 space-y-2 text-sm text-gray-700">
          <li>
            {t('petSafeSpecies.readingSafeIntro')}{' '}
            <Link
              to={`/blog/${PET_SAFETY_POSTS.safe.slug}`}
              className="text-primary-700 underline hover:text-primary-800"
            >
              {PET_SAFETY_POSTS.safe.title}
            </Link>
          </li>
          <li>
            {t('petSafeSpecies.readingToxicIntro')}{' '}
            <Link
              to={`/blog/${PET_SAFETY_POSTS.toxic.slug}`}
              className="text-primary-700 underline hover:text-primary-800"
            >
              {PET_SAFETY_POSTS.toxic.title}
            </Link>
          </li>
        </ul>
      </section>
    </>
  );
}

function ToxicityCard({ match }: { match: ToxicityMatch }) {
  const safeForBoth = match.cats === 'non-toxic' && match.dogs === 'non-toxic';
  const variant = safeForBoth ? 'success' : 'warning';
  const title = safeForBoth
    ? `${match.commonName} is pet-safe`
    : `${match.commonName} can be harmful to pets`;

  // `live="off"`: PetSafePage renders these inside its own polite region.
  return (
    <Alert variant={variant} title={title} live="off">
      <p className="italic">{match.scientificName}</p>
      <ul className="mt-2 space-y-1">
        <li>
          <span className="font-medium">Cats:</span>{' '}
          {match.cats === 'toxic' ? 'Toxic' : 'Non-toxic'}
        </li>
        <li>
          <span className="font-medium">Dogs:</span>{' '}
          {match.dogs === 'toxic' ? 'Toxic' : 'Non-toxic'}
        </li>
      </ul>
      <p className="mt-2">{match.note}</p>
    </Alert>
  );
}
