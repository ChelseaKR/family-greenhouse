import {
  ASPCA_ANIMAL_POISON_CONTROL_URL,
  PET_TOXICITY,
  type PetToxicityEntry,
} from '../../../../backend/src/models/petToxicity';
import { SITE_URL, siteUrl } from '@/config/site';
import type { MetaTags } from '@/config/seo';

/**
 * The data behind `/pet-safe/<slug>`: one page per plant in the curated
 * pet-toxicity table, and nothing on it that the table does not say.
 *
 * ## Why the page reads the backend's table directly
 *
 * `backend/src/models/petToxicity.ts` is the ASPCA-grounded table that already
 * answers `GET /species/toxicity` and the assistant's `check_pet_toxicity`
 * tool, and ADR 0011 makes it the only toxicity source. Importing it here —
 * rather than copying it, or reading `careGuides.ts` the way `/pet-safe`'s
 * directory does — means a page cannot say something about a plant that the
 * checker would not. The file imports nothing, so it bundles as plain data.
 *
 * ## What a page may claim (the safety rule)
 *
 * A verdict for an animal is shown only when the table records exactly
 * `toxic` or `non-toxic` for it AND the entry's own ASPCA listing states that
 * same verdict. Otherwise that animal reads "Not assessed". Absence is never
 * rendered as safety: a blank, missing, or unexpected field, an entry with no
 * per-plant listing, and a listing that is silent or disagrees all land on
 * "Not assessed", and nothing here has a default of "non-toxic".
 *
 * A plant with no published verdict for either animal gets no page at all:
 * a page whose every line is "Not assessed" answers nothing, and the table's
 * unlisted verdicts are exactly the claims this rule refuses to print.
 *
 * `frontend/scripts/pet-toxicity-table.mjs` implements the same rule for the
 * build. The build gate (`check-plant-safety-pages.mjs`) compares every
 * prerendered page against that implementation, and
 * `tests/unit/features/plantSafetyPages.test.ts` holds the two to the same
 * answers, so neither can loosen alone.
 */

export const ANIMALS = ['cats', 'dogs'] as const;
export type Animal = (typeof ANIMALS)[number];

export type Verdict = 'toxic' | 'non-toxic';
export type ClaimState = Verdict | 'not-assessed';

export interface CitedSource {
  /** The listing's title, as ASPCA shows it. */
  title: string;
  /** The species that listing names. */
  scientificName: string;
  url: string;
}

export type AnimalClaim =
  | { state: Verdict; source: CitedSource }
  | {
      state: 'not-assessed';
    };

export interface PlantSafetyPage {
  slug: string;
  commonName: string;
  scientificName: string;
  /** The table's note — only when every animal's verdict is cited, else null. */
  note: string | null;
  claims: Record<Animal, AnimalClaim>;
}

/**
 * An entry as it might arrive, not as the type promises. The table is typed,
 * but the rule below is the last line between a data mistake and a pet owner,
 * so it is written against values that are blank, missing or wrong.
 */
export type LooseEntry = { [K in keyof PetToxicityEntry]?: unknown };

const VERDICTS: readonly unknown[] = ['toxic', 'non-toxic'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LISTING_PATH = /^\/toxic-and-non-toxic-plants\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NOT_ASSESSED: AnimalClaim = { state: 'not-assessed' };

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

/** What a page may say about one animal. See the module header. */
export function claimFor(entry: LooseEntry, animal: Animal): AnimalClaim {
  const recorded = entry[animal];
  if (!VERDICTS.includes(recorded)) return NOT_ASSESSED;

  const listing = entry.aspcaListing;
  if (!isRecord(listing) || !isText(listing.title) || !isText(listing.scientificName)) {
    return NOT_ASSESSED;
  }
  if (typeof listing.path !== 'string' || !LISTING_PATH.test(listing.path)) return NOT_ASSESSED;
  if (!isRecord(listing.listed) || listing.listed[animal] !== recorded) return NOT_ASSESSED;

  return {
    state: recorded as Verdict,
    source: {
      title: listing.title,
      scientificName: listing.scientificName,
      url: `${ASPCA_ANIMAL_POISON_CONTROL_URL}${listing.path}`,
    },
  };
}

/** The page an entry gets, or null when it publishes no verdict at all. */
export function toPlantSafetyPage(entry: LooseEntry): PlantSafetyPage | null {
  const { slug, commonName, scientificName, note } = entry;
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
  if (!isText(commonName) || !isText(scientificName)) return null;

  const claims = { cats: claimFor(entry, 'cats'), dogs: claimFor(entry, 'dogs') };
  const cited = ANIMALS.filter((animal) => claims[animal].state !== 'not-assessed');
  if (cited.length === 0) return null;

  return {
    slug,
    commonName,
    scientificName,
    note: cited.length === ANIMALS.length && isText(note) ? note : null,
    claims,
  };
}

/** Every published page, in table order. */
export const PLANT_SAFETY_PAGES: PlantSafetyPage[] = PET_TOXICITY.map(toPlantSafetyPage).filter(
  (page): page is PlantSafetyPage => page !== null
);

/** React Router matches case-insensitively, so the slug lookup does too. */
export function findPlantSafetyPage(slug: string): PlantSafetyPage | undefined {
  const wanted = slug.toLowerCase();
  return PLANT_SAFETY_PAGES.find((page) => page.slug === wanted);
}

/** The distinct listings a page cites, in animal order. */
export function citedSources(page: PlantSafetyPage): CitedSource[] {
  const seen = new Map<string, CitedSource>();
  for (const animal of ANIMALS) {
    const claim = page.claims[animal];
    if (claim.state !== 'not-assessed' && !seen.has(claim.source.url)) {
      seen.set(claim.source.url, claim.source);
    }
  }
  return [...seen.values()];
}

/** The catalog key for each state's label. The build gate reads the same keys. */
export const VERDICT_LABEL_KEY: Record<ClaimState, string> = {
  toxic: 'plantSafetyPage.verdict.toxic',
  'non-toxic': 'plantSafetyPage.verdict.nonToxic',
  'not-assessed': 'plantSafetyPage.verdict.notAssessed',
};

export const PLANT_PAGE_PREFIX = '/pet-safe/';

/** The poison-control line the emergency note links, from the table module. */
export const POISON_CONTROL_URL = ASPCA_ANIMAL_POISON_CONTROL_URL;

type Translate = (key: string, options?: Record<string, string>) => string;

/**
 * The page's `<head>`, composed from the same catalog strings and table fields
 * as its body. The build gate recomposes this independently and compares it
 * byte for byte, so the title, description and structured data cannot carry
 * a claim the body does not.
 *
 * Structured data describes the page and nothing else: a `WebPage` about the
 * plant, citing the listing(s) its verdicts come from, and a breadcrumb.
 */
export function plantSafetyMeta(page: PlantSafetyPage, t: Translate): MetaTags {
  const url = siteUrl(`${PLANT_PAGE_PREFIX}${page.slug}`);
  const title = t('plantSafetyPage.metaTitle', { name: page.commonName });
  const description = t('plantSafetyPage.metaDescription', {
    name: page.commonName,
    scientificName: page.scientificName,
    cats: t(VERDICT_LABEL_KEY[page.claims.cats.state]),
    dogs: t(VERDICT_LABEL_KEY[page.claims.dogs.state]),
  });

  return {
    title,
    description,
    canonical: url,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          '@id': url,
          url,
          name: title,
          description,
          inLanguage: 'en',
          isPartOf: {
            '@type': 'WebSite',
            '@id': `${SITE_URL}/#website`,
            name: 'Family Greenhouse',
            url: SITE_URL,
          },
          about: { '@type': 'Thing', name: page.commonName, alternateName: page.scientificName },
          citation: citedSources(page).map((source) => ({
            '@type': 'CreativeWork',
            name: t('plantSafetyPage.citation', {
              title: source.title,
              scientificName: source.scientificName,
            }),
            url: source.url,
          })),
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: t('plantSafetyPage.breadcrumbHome'),
              item: siteUrl('/'),
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: t('plantSafetyPage.breadcrumbHub'),
              item: siteUrl('/pet-safe'),
            },
            { '@type': 'ListItem', position: 3, name: page.commonName },
          ],
        },
      ],
    },
  };
}
