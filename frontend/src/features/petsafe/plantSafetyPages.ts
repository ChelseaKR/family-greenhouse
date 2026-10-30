import {
  ASPCA_ANIMAL_POISON_CONTROL_URL,
  ASPCA_PLANT_LIST_URL,
  EXTENSION_SOURCE_ORIGINS,
  PET_TOXICITY,
  type PetToxicityEntry,
} from '../../../../backend/src/models/petToxicity';
import { SITE_URL, siteUrl } from '@/config/site';
import type { MetaTags } from '@/config/seo';
import { sentenceName } from '@/features/care/plantNames';
import { ASPCA_POISON_CONTROL_TEL, PET_POISON_HELPLINE_TEL } from './petVerdict';

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

/**
 * Animals shown only where the plant's own listing states a verdict, through
 * the same claimFor() rule. Kept out of ANIMALS so they never decide whether a
 * page is published, whether its note shows, or whether it may carry a shop link.
 */
export const OPTIONAL_ANIMALS = ['horses'] as const;
export type OptionalAnimal = (typeof OPTIONAL_ANIMALS)[number];
export type AnyAnimal = Animal | OptionalAnimal;

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
export function claimFor(entry: LooseEntry, animal: AnyAnimal): AnimalClaim {
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

// ---------------------------------------------------------------------------
// Detailed pages: quoted listing fields, a second source, similar plants, FAQ.
// ---------------------------------------------------------------------------

/** Fields of an ASPCA listing a detailed page quotes, in display order. */
export const LISTING_FIELDS = [
  'additionalCommonNames',
  'family',
  'toxicPrinciples',
  'clinicalSigns',
  'listingNote',
  'listingAdvice',
] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];

/** Fields of an extension source a detailed page quotes, in display order. */
export const EXTENSION_FIELDS = [
  'poisonSeverity',
  'poisonSymptoms',
  'poisonToxicPrinciple',
  'poisonPart',
] as const;
export type ExtensionField = (typeof EXTENSION_FIELDS)[number];

export { ASPCA_PLANT_LIST_URL };

export interface ExtensionDetails {
  publisher: string;
  title: string;
  database: string;
  url: string;
  fields: { field: ExtensionField; value: string }[];
  /** Animals the source tags "non-toxic" AND the ASPCA listing cites as non-toxic. */
  tags: AnyAnimal[];
}

export interface PlantSafetyDetails {
  horses: AnimalClaim;
  listing: { field: ListingField; value: string }[];
  extension: ExtensionDetails | null;
  alternatives: PlantSafetyPage[];
  related: PlantSafetyPage[];
  /** True when cats or dogs is a cited "toxic": picks the alternatives heading. */
  anyToxic: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const squashText = (value: string) => value.replace(/\s+/g, ' ').trim();
const ALL_ANIMALS: readonly AnyAnimal[] = [...ANIMALS, ...OPTIONAL_ANIMALS];

/**
 * What a detailed page shows beyond its verdicts, from the table alone. A page
 * is detailed only when its listing records `detailsRead`; otherwise null.
 *
 * Must match plantDetails() in scripts/pet-toxicity-table.mjs, which the build
 * gate uses to check the prerendered page (plantSafetyPages.test compares the
 * two on every entry). The rules, each of which fails closed:
 *   - a horse verdict shows only when cited, exactly as for cats and dogs;
 *   - a quoted field shows only when it is non-blank text;
 *   - the extension source shows only when well formed and under an allowed
 *     origin, and a "non-toxic" tag from it only where the ASPCA listing cites
 *     the same "non-toxic" for that animal: a second source may agree with a
 *     safety verdict, never supply one;
 *   - an alternative shows only when its own page cites "non-toxic" for both
 *     cats and dogs; a related plant only when it is published.
 */
export function plantSafetyDetailsFrom(
  entry: LooseEntry,
  pages: readonly PlantSafetyPage[]
): PlantSafetyDetails | null {
  const page = toPlantSafetyPage(entry);
  const listing = entry.aspcaListing;
  if (!page || !isRecord(listing)) return null;
  const read = listing.detailsRead;
  if (!isText(read) || !ISO_DATE.test(read)) return null;

  const listingFields = LISTING_FIELDS.flatMap((field) => {
    const value = listing[field];
    return isText(value) ? [{ field, value: squashText(value) }] : [];
  });

  let extension: ExtensionDetails | null = null;
  const ext = entry.extensionSource;
  if (isRecord(ext)) {
    const { publisher, title, database, url, read: extRead } = ext;
    if (
      isText(publisher) &&
      isText(title) &&
      isText(database) &&
      isText(extRead) &&
      typeof url === 'string' &&
      /^https:\/\/\S+$/.test(url) &&
      EXTENSION_SOURCE_ORIGINS.some(
        (origin) => url.startsWith(origin) && url.length > origin.length
      )
    ) {
      const tagged = isRecord(ext.tagged) ? ext.tagged : {};
      const fields = EXTENSION_FIELDS.flatMap((field) => {
        const value = ext[field];
        return isText(value) ? [{ field, value: squashText(value) }] : [];
      });
      const tags = ALL_ANIMALS.filter(
        (animal) => tagged[animal] === 'non-toxic' && claimFor(entry, animal).state === 'non-toxic'
      );
      if (fields.length > 0 || tags.length > 0) {
        extension = { publisher, title, database, url, fields, tags };
      }
    }
  }

  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const slugs = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
  const alternatives: PlantSafetyPage[] = [];
  for (const slug of slugs(entry.alternatives)) {
    const target = bySlug.get(slug);
    if (!target || slug === page.slug || alternatives.includes(target)) continue;
    if (ANIMALS.every((a) => target.claims[a].state === 'non-toxic')) alternatives.push(target);
  }
  const related: PlantSafetyPage[] = [];
  for (const slug of slugs(entry.related)) {
    const target = bySlug.get(slug);
    if (
      !target ||
      slug === page.slug ||
      alternatives.includes(target) ||
      related.includes(target)
    ) {
      continue;
    }
    related.push(target);
  }

  return {
    horses: claimFor(entry, 'horses'),
    listing: listingFields,
    extension,
    alternatives,
    related,
    anyToxic: ANIMALS.some((a) => page.claims[a].state === 'toxic'),
  };
}

/** The details of a published page, from the real table. */
export function plantSafetyDetails(page: PlantSafetyPage): PlantSafetyDetails | null {
  const entry = PET_TOXICITY.find((row) => row.slug === page.slug);
  return entry ? plantSafetyDetailsFrom(entry as LooseEntry, PLANT_SAFETY_PAGES) : null;
}

export interface FaqItem {
  id: AnyAnimal | 'parts' | 'whatToDo';
  question: string;
  answer: string;
}

/**
 * The FAQ a detailed page prints and publishes as FAQPage: one question per
 * cited animal (cats, dogs, then horses when cited), then which parts are
 * poisonous (only where the extension source quotes its "Poison Part" values
 * and the ASPCA cites "toxic" for cats or dogs), then what to do. Every
 * word is a catalog template filled from the table, and an animal whose
 * verdict is not cited gets no question. Must match plantFaq() in
 * scripts/pet-toxicity-table.mjs, which the build gate recomposes.
 */
export function plantSafetyFaq(
  page: PlantSafetyPage,
  details: PlantSafetyDetails | null,
  t: Translate
): FaqItem[] {
  if (!details) return [];
  const name = sentenceName(headName(page.commonName));
  const listing = Object.fromEntries(details.listing.map((f) => [f.field, f.value])) as Partial<
    Record<ListingField, string>
  >;
  const items: FaqItem[] = [];
  for (const animal of ALL_ANIMALS) {
    const claim = animal === 'horses' ? details.horses : page.claims[animal];
    if (claim.state === 'not-assessed') continue;
    const animalWord = t(`plantSafetyPage.faq.animal.${animal}`);
    const parts = [
      t(
        claim.state === 'toxic'
          ? 'plantSafetyPage.faq.answerToxic'
          : 'plantSafetyPage.faq.answerNonToxic',
        {
          title: claim.source.title,
          scientificName: claim.source.scientificName,
          animal: animalWord,
        }
      ),
    ];
    if (claim.state === 'toxic' && listing.toxicPrinciples && listing.clinicalSigns) {
      parts.push(
        t('plantSafetyPage.faq.answerDetails', {
          principles: listing.toxicPrinciples,
          signs: listing.clinicalSigns.replace(/\.$/, ''),
        })
      );
    }
    if (claim.state === 'non-toxic' && (ANIMALS as readonly string[]).includes(animal)) {
      parts.push(t('plantSafetyPage.faq.answerAnyPlant'));
    }
    items.push({
      id: animal,
      question: t('plantSafetyPage.faq.question', { name, animal: animalWord }),
      answer: parts.join(' '),
    });
  }
  const parts = details.extension?.fields.find((f) => f.field === 'poisonPart')?.value;
  if (details.anyToxic && parts && details.extension) {
    items.push({
      id: 'parts',
      question: t('plantSafetyPage.faq.partsQuestion', { name }),
      answer: t('plantSafetyPage.faq.partsAnswer', {
        publisher: details.extension.publisher,
        database: details.extension.database,
        parts,
      }),
    });
  }
  items.push({
    id: 'whatToDo',
    question: t('plantSafetyPage.faq.whatToDoQuestion', { name }),
    answer: t('plantSafetyPage.faq.whatToDoAnswer'),
  });
  return items;
}

/** The catalog key for each state's label. The build gate reads the same keys. */
export const VERDICT_LABEL_KEY: Record<ClaimState, string> = {
  toxic: 'plantSafetyPage.verdict.toxic',
  'non-toxic': 'plantSafetyPage.verdict.nonToxic',
  'not-assessed': 'plantSafetyPage.verdict.notAssessed',
};

export const PLANT_PAGE_PREFIX = '/pet-safe/';

/**
 * The two pet poison hotlines the emergency aside lists, in order, with the
 * catalog keys for their link text (name and number) and their fee sentence.
 * Numbers and fee wording were read off each service's own page on 2026-10-23
 * (see plantNames.ts). Must match POISON_HOTLINES in
 * scripts/check-plant-safety-pages.mjs, which checks the built pages.
 */
export const POISON_HOTLINES = [
  {
    id: 'aspca',
    tel: ASPCA_POISON_CONTROL_TEL,
    callKey: 'plantSafetyPage.hotline.aspca',
    feeKey: 'plantSafetyPage.hotlineFee.aspca',
  },
  {
    id: 'petPoisonHelpline',
    tel: PET_POISON_HELPLINE_TEL,
    callKey: 'plantSafetyPage.hotline.petPoisonHelpline',
    feeKey: 'plantSafetyPage.hotlineFee.petPoisonHelpline',
  },
] as const;

/**
 * The plant's name as the head and the H1 spell it: the table's `commonName`
 * without a trailing disambiguation in parentheses ("Orchid (Phalaenopsis)" ->
 * "orchid"), cased as it reads mid-question. The table's sentence-case
 * `commonName` used to go in verbatim, so 40 titles in search results read "Is
 * Peace lily toxic to cats and dogs?". The scientific name follows in the
 * description, and the longest title has to fit a SERP's ~60 characters. Both
 * head catalogs (en and es) take it as `{{name}}`, the H1 as `{{questionName}}`.
 * The build gate recomposes it with `faqName()` in pet-toxicity-table.mjs.
 */
export function headName(commonName: string): string {
  return sentenceName(commonName.replace(/\s*\([^)]*\)\s*$/, ''));
}

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
  const details = plantSafetyDetails(page);
  const faq = plantSafetyFaq(page, details, t);
  const title = t('plantSafetyPage.metaTitle', { name: headName(page.commonName) });
  const description = t('plantSafetyPage.metaDescription', {
    name: headName(page.commonName),
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
          citation: [
            ...citedSources(page).map((source) => ({
              '@type': 'CreativeWork',
              name: t('plantSafetyPage.citation', {
                title: source.title,
                scientificName: source.scientificName,
              }),
              url: source.url,
            })),
            ...(details?.extension
              ? [
                  {
                    '@type': 'CreativeWork',
                    name: t('plantSafetyPage.extensionCitation', {
                      publisher: details.extension.publisher,
                      title: details.extension.title,
                      database: details.extension.database,
                    }),
                    url: details.extension.url,
                  },
                ]
              : []),
          ],
        },
        ...(faq.length > 0
          ? [
              {
                '@type': 'FAQPage',
                '@id': `${url}#faq`,
                mainEntity: faq.map((item) => ({
                  '@type': 'Question',
                  name: item.question,
                  acceptedAnswer: { '@type': 'Answer', text: item.answer },
                })),
              },
            ]
          : []),
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
