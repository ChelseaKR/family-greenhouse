import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PublicShell } from '@/components/PublicShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { EmergencyAside, PlantSafetyArticle } from './PlantSafetyArticle';
import { findPlantSafetyPage, plantSafetyMeta } from './plantSafetyPages';

/**
 * `/pet-safe/<slug>`: "is this plant toxic to cats and dogs?", answered from
 * the curated table and nothing else.
 *
 * ## The markup is part of the safety check
 *
 * Every piece of visible text inside `<article data-plant-safety>` sits in an
 * element that says where it came from:
 *
 *   - `data-claim="verdict" data-animal data-state` — a verdict label, whose
 *     state the build gate recomputes from the table;
 *   - `data-claim="citation"` — the ASPCA listing a verdict or note rests on;
 *   - `data-claim="note"` — the table's note, verbatim;
 *   - `data-field="scientificName"` — a table field, verbatim;
 *   - `data-chrome="<catalog key>"` — template copy from the i18n catalog.
 *
 * A detailed page (its listing records `detailsRead`) adds quoted listing and
 * extension fields, a horse verdict where the listing states one, similar and
 * related plants with their own verdicts, and an FAQ, each under its own
 * `data-claim` kind that the gate recomposes from the table (assertion 7 in
 * the gate's header).
 *
 * (The body lives in PlantSafetyArticle.tsx, so this module exports only the
 * route component `App.tsx` lazy-loads.) The page opens with the emergency
 * aside (two poison hotlines, each a `tel:` link with its fee in its own
 * words), ahead of the verdicts, on every page; the gate checks that too.
 *
 * `scripts/check-plant-safety-pages.mjs` fails the build if any text sits
 * outside those, if a chrome string differs from its catalog entry, or if a
 * claim differs from what the table supports. So adding a sentence to this
 * template means adding a catalog key the gate can read, and a sentence about
 * a plant cannot be added here at all. Keep new copy inside a `data-chrome`
 * element and free of plant-specific claims.
 */
export function PetSafePlantPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useTranslation();
  const page = slug ? findPlantSafetyPage(slug) : undefined;

  useMetaTags(
    page
      ? plantSafetyMeta(page, t)
      : {
          title: t('plantSafetyPage.unknownTitle'),
          description: t('plantSafetyPage.unknownBody'),
          robots: 'noindex, follow',
        }
  );

  return (
    <PublicShell width="article">
      {page ? <PlantSafetyArticle page={page} /> : <UnknownPlant />}
    </PublicShell>
  );
}

const LINK = 'text-primary-700 underline hover:text-primary-800';

/**
 * A slug with no published page: not in the table, or in it without a cited
 * verdict. The edge answers 404 for these (no object exists), so this renders
 * only after in-app navigation. It says nothing about the plant — the table's
 * uncited verdict included — and is `noindex`. It still leads with the
 * emergency aside: a reader on this page may have a pet that ate the plant.
 */
function UnknownPlant() {
  const { t } = useTranslation();

  return (
    <article data-plant-safety="">
      <EmergencyAside />
      <h1
        data-chrome="plantSafetyPage.unknownTitle"
        className="mt-8 font-serif text-4xl tracking-tight text-ink"
      >
        {t('plantSafetyPage.unknownTitle')}
      </h1>
      <p data-chrome="plantSafetyPage.unknownBody" className="mt-4 text-gray-700">
        {t('plantSafetyPage.unknownBody')}
      </p>
      <p className="mt-6">
        <Link to="/pet-safe" data-chrome="plantSafetyPage.unknownCta" className={LINK}>
          {t('plantSafetyPage.unknownCta')}
        </Link>
      </p>
    </article>
  );
}
