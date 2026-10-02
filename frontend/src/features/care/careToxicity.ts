import { PET_TOXICITY } from '../../../../backend/src/models/petToxicity';
import {
  ANIMALS,
  claimFor,
  findPlantSafetyPage,
  type Animal,
  type AnimalClaim,
  type LooseEntry,
} from '@/features/petsafe/plantSafetyPages';
import type { CareGuide } from './careGuides';

/**
 * What a care guide may say about pet toxicity, and where it says it.
 *
 * Until 2026-10-02 every guide carried its own hand-written toxicity line and
 * a hand-written "Is X toxic to cats and dogs?" FAQ, published as FAQPage
 * structured data. Fifteen of the 24 said "per the ASPCA" with no per-plant
 * listing on record, and one (ZZ plant) asserted a verdict the ASPCA does not
 * list at all. This module replaces the hand-written answer with the one the
 * curated table can cite, using the same rule the `/pet-safe/<slug>` pages
 * use (`claimFor` in plantSafetyPages.ts):
 *
 *   - an animal's verdict is published only when the table records it AND
 *     the entry's own ASPCA listing states the same verdict;
 *   - anything else is "unknown": no listing, a blank or unexpected field, a
 *     listing that is silent or disagrees. Absence is never rendered as safe.
 *
 * The page's FAQPage JSON-LD carries the toxicity question only when every
 * animal is cited (`sourced`). An "unknown" answer is still shown to the
 * reader, because it is the honest answer to a question they asked, but it
 * is not published as structured data.
 *
 * People are out of scope for the source: the ASPCA assesses animals. The
 * page says so and points to Poison Help instead of guessing.
 */

/**
 * The table entry a guide reads, when its slug differs from the guide's. The
 * heartleaf philodendron guide reads the genus-level `philodendron` row, which
 * carries the ASPCA "Heartleaf Philodendron" listing.
 */
const TABLE_SLUG_FOR_GUIDE: Readonly<Record<string, string>> = {
  'heartleaf-philodendron': 'philodendron',
};

export interface CareToxicity {
  /** Per-animal claim, as the /pet-safe pages compute it. */
  claims: Record<Animal, AnimalClaim>;
  /** True only when every animal's verdict is cited. Gates the FAQ markup. */
  sourced: boolean;
  /** The table's note: only when `sourced`, else null. */
  note: string | null;
  /** `/pet-safe/<slug>` when that page is published, else null. */
  petSafePath: string | null;
  /** The generated FAQ: always shown on the page. */
  faq: { q: string; a: string };
}

const UNKNOWN: AnimalClaim = { state: 'not-assessed' };

/**
 * A common name as it reads mid-sentence: "pothos", "ZZ plant", "English
 * ivy". `toLowerCase()` alone gave headings like "how often to water a zz
 * plant" and "a english ivy".
 */
export function sentenceName(commonName: string): string {
  const KEEP_CASE = new Set(['English', 'Chinese', 'Boston', 'Christmas']);
  return commonName
    .split(' ')
    .map((w) => (KEEP_CASE.has(w) || /^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/** "a pothos", "an aloe vera", "a ZZ plant", "an English ivy". */
export function nameInSentence(commonName: string): string {
  const name = sentenceName(commonName);
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

const VERDICT_WORD = { toxic: 'toxic', 'non-toxic': 'non-toxic' } as const;

function citedAnswer(claims: Record<Animal, AnimalClaim>, note: string | null): string {
  const cats = claims.cats;
  const dogs = claims.dogs;
  if (cats.state !== 'not-assessed' && dogs.state !== 'not-assessed') {
    if (cats.state === dogs.state && cats.source.url === dogs.source.url) {
      const lead = cats.state === 'toxic' ? 'Yes.' : 'No.';
      const sentence = `${lead} The ASPCA lists ${cats.source.title} (${cats.source.scientificName}) as ${VERDICT_WORD[cats.state]} to cats and dogs.`;
      return note ? `${sentence} ${note}` : sentence;
    }
  }
  const parts = ANIMALS.map((animal) => {
    const claim = claims[animal];
    return claim.state === 'not-assessed'
      ? `For ${animal}, our source gives no verdict.`
      : `The ASPCA lists ${claim.source.title} (${claim.source.scientificName}) as ${VERDICT_WORD[claim.state]} to ${animal}.`;
  });
  return parts.join(' ');
}

const UNKNOWN_ANSWER =
  'We don’t know, and we won’t guess. The ASPCA plant list, the source this site uses for pet toxicity, has no entry for this plant. Keep it out of reach of pets that chew, and if one eats some, call your vet or the ASPCA Animal Poison Control Center.';

/**
 * The toxicity view of a guide, from a given table. `table` is injectable so
 * tests can feed it broken or missing rows (the negative controls); the page
 * always uses the real one.
 */
export function careToxicityFrom(
  guide: Pick<CareGuide, 'slug' | 'commonName'>,
  table: readonly LooseEntry[]
): CareToxicity {
  const tableSlug = TABLE_SLUG_FOR_GUIDE[guide.slug] ?? guide.slug;
  const entry = table.find((row) => row.slug === tableSlug);

  const claims: Record<Animal, AnimalClaim> = entry
    ? { cats: claimFor(entry, 'cats'), dogs: claimFor(entry, 'dogs') }
    : { cats: UNKNOWN, dogs: UNKNOWN };
  const sourced = ANIMALS.every((animal) => claims[animal].state !== 'not-assessed');
  const anyCited = ANIMALS.some((animal) => claims[animal].state !== 'not-assessed');
  const rawNote = entry?.note;
  const note = sourced && typeof rawNote === 'string' && rawNote.trim() ? rawNote : null;
  const page = anyCited ? findPlantSafetyPage(tableSlug) : undefined;

  return {
    claims,
    sourced,
    note,
    petSafePath: page ? `/pet-safe/${page.slug}` : null,
    faq: {
      q: `Is ${nameInSentence(guide.commonName)} toxic to cats and dogs?`,
      a: anyCited ? citedAnswer(claims, note) : UNKNOWN_ANSWER,
    },
  };
}

export function careToxicity(guide: Pick<CareGuide, 'slug' | 'commonName'>): CareToxicity {
  return careToxicityFrom(guide, PET_TOXICITY as readonly LooseEntry[]);
}
