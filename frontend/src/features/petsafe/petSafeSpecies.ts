import { CARE_GUIDES } from '@/features/care/careGuides';

/**
 * The static half of `/pet-safe`: every species we publish a care guide for,
 * carrying that guide's OWN pet-toxicity line.
 *
 * The checker on `/pet-safe` answers from `GET /species/toxicity` at runtime,
 * so the prerendered HTML a crawler sees was an empty search form — ~187 words
 * and not one of the toxicity answers the page exists to give. This module is
 * the data behind the crawlable list that fixes that, and it is derived, not
 * re-authored: the verdict shown for a species is `quickFacts.toxicity` from
 * `careGuides.ts`, verbatim, never a restatement.
 *
 * That matters more here than anywhere else on the site. A pet owner acts on
 * this line. `careGuides.ts` names `quickFacts.toxicity` as one of the two
 * fields "a wrong answer does real harm on", and it is reviewed as such — so
 * it is the single source, and the only transformation applied to it is the
 * grouping below, which reads its opening verdict and nothing else.
 */

/**
 * How a species is grouped and badged. `unclear` is not currently reachable
 * from the data (all 24 guides open with "Toxic", "Mildly toxic" or
 * "Non-toxic") and exists so a future guide phrased some other way is shown
 * with its own words and no badge claim, rather than being silently sorted
 * into "safe".
 */
export type PetSafetyLevel = 'safe' | 'caution' | 'toxic' | 'unclear';

export interface PetSafeSpecies {
  slug: string;
  commonName: string;
  scientificName: string;
  /** `quickFacts.toxicity` from the species' care guide, verbatim. */
  verdict: string;
  level: PetSafetyLevel;
}

/**
 * Classify on the guide line's opening verdict only.
 *
 * Deliberately not a keyword search: "Non-toxic to cats and dogs (per the
 * ASPCA), though cats love chewing it" contains "toxic" twice, and a
 * `includes('toxic')` test would file the ASPCA's own non-toxic ruling under
 * "toxic". The guides all lead with the verdict, so the prefix is both the
 * most reliable signal and the one a reader sees first.
 *
 * Anything that does not lead with a verdict we recognise is `unclear` — the
 * full line is still rendered, so the reader loses a badge, not an answer.
 */
export function petSafetyLevel(toxicity: string): PetSafetyLevel {
  const line = toxicity.trim().toLowerCase();
  if (line.startsWith('non-toxic')) return 'safe';
  if (line.startsWith('mildly toxic')) return 'caution';
  if (line.startsWith('toxic')) return 'toxic';
  return 'unclear';
}

const SPECIES: PetSafeSpecies[] = CARE_GUIDES.map((guide) => ({
  slug: guide.slug,
  commonName: guide.commonName,
  scientificName: guide.scientificName,
  verdict: guide.quickFacts.toxicity,
  level: petSafetyLevel(guide.quickFacts.toxicity),
}));

export type PetSafeGroupId = 'safe' | 'unsafe' | 'unclear';

export interface PetSafeGroup {
  id: PetSafeGroupId;
  species: PetSafeSpecies[];
}

const byCommonName = (a: PetSafeSpecies, b: PetSafeSpecies) =>
  a.commonName.localeCompare(b.commonName, 'en');

const pick = (...levels: PetSafetyLevel[]) =>
  SPECIES.filter((s) => levels.includes(s.level)).sort(byCommonName);

/**
 * Grouped for the reader, not for the crawler: "which of these can I have
 * with a cat" is the question, and answering it needs the safe ones together.
 * `caution` sits with `toxic` because "mildly toxic" is still not safe — the
 * badge keeps the distinction the guide draws without moving it across the
 * heading that tells a pet owner what to do.
 *
 * Empty groups are dropped so a heading never promises a list that isn't there.
 */
export const PET_SAFE_GROUPS: PetSafeGroup[] = (
  [
    { id: 'safe', species: pick('safe') },
    { id: 'unsafe', species: pick('toxic', 'caution') },
    { id: 'unclear', species: pick('unclear') },
  ] as PetSafeGroup[]
).filter((group) => group.species.length > 0);

/**
 * The same species, flattened in the order they are rendered, so the
 * `ItemList` JSON-LD positions match the DOM a crawler reads them from.
 */
export const PET_SAFE_SPECIES: PetSafeSpecies[] = PET_SAFE_GROUPS.flatMap((g) => g.species);

/**
 * The two pet-safety blog posts, restated here rather than imported from
 * `@/features/blog/posts`: that module eagerly imports all fourteen post
 * components, so importing it would pull the entire blog prose chunk into the
 * lazy `/pet-safe` chunk for the sake of two titles.
 *
 * `tests/unit/features/petSafeSpecies.test.ts` asserts both slugs and both
 * titles still match `POSTS`, so a renamed post fails a test instead of
 * quietly shipping a dead link or stale anchor text.
 */
export const PET_SAFETY_POSTS = {
  safe: {
    slug: 'pet-safe-houseplants-that-are-hard-to-kill',
    title: 'Pet-safe houseplants that are genuinely hard to kill',
  },
  toxic: {
    slug: 'most-common-toxic-houseplants-and-safer-swaps',
    title: 'The most common toxic houseplants (and safer swaps)',
  },
} as const;
