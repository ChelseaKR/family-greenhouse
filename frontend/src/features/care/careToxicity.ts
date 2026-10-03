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
import i18n from '@/i18n';
import { petCaution, type PetVerdict } from '@/features/petsafe/petVerdict';
import { ASPCA_POISON_CONTROL_PHONE, nameInSentence, sentenceName } from './plantNames';

export { ASPCA_POISON_CONTROL_PHONE, nameInSentence, sentenceName };

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
  /**
   * The plain caution shown wherever an animal resolves to "Unknown": on the
   * care page and in the /pet-safe directory. Null when every animal is
   * cited. It never states or implies a verdict, only what to do.
   */
  caution: string | null;
  /** The generated FAQ: always shown on the page. */
  faq: { q: string; a: string };
}

const UNKNOWN: AnimalClaim = { state: 'not-assessed' };

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

/**
 * The caution for a plant with at least one "Unknown" animal, in English (the
 * care pages are English-only). The words live once, in the en catalog
 * (`petSafety.caution.*`), and `petCaution` is the one function that phrases
 * them, so the care pages, the /pet-safe directory, the checker, the sitter
 * brief and the passport cannot drift apart. Owner-approved wording
 * (2026-10-02); careToxicity.test pins the exact ZZ plant sentence.
 */
const englishT = (key: string, options?: Record<string, string>) =>
  i18n.getFixedT('en')(key, options);

export function cautionFor(commonName: string, unknownAnimals: readonly Animal[]): string | null {
  const verdict = (animal: Animal): PetVerdict =>
    unknownAnimals.includes(animal) ? 'unknown' : 'toxic';
  return petCaution(englishT, commonName, verdict('cats'), verdict('dogs'));
}

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
  const caution = cautionFor(
    guide.commonName,
    ANIMALS.filter((animal) => claims[animal].state === 'not-assessed')
  );

  return {
    claims,
    sourced,
    note,
    petSafePath: page ? `/pet-safe/${page.slug}` : null,
    caution,
    faq: {
      q: `Is ${nameInSentence(guide.commonName)} toxic to cats and dogs?`,
      // `caution` is non-null whenever any animal is unknown.
      a: anyCited
        ? caution
          ? `${citedAnswer(claims, note)} ${caution}`
          : citedAnswer(claims, note)
        : caution!,
    },
  };
}

export function careToxicity(guide: Pick<CareGuide, 'slug' | 'commonName'>): CareToxicity {
  return careToxicityFrom(guide, PET_TOXICITY as readonly LooseEntry[]);
}
