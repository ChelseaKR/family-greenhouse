import { describe, expect, it } from 'vitest';

import { CARE_GUIDES } from '@/features/care/careGuides';
import { POSTS } from '@/features/blog/posts';
import {
  PET_SAFE_GROUPS,
  PET_SAFE_SPECIES,
  PET_SAFETY_POSTS,
  petSafetyLevel,
} from '@/features/petsafe/petSafeSpecies';

/**
 * The data behind the static `/pet-safe` list. These cases exist because the
 * page publishes pet-safety verdicts a reader acts on: the classifier must
 * never invent, soften or flip one, and the verdict text must stay the care
 * guide's own sentence.
 */
describe('petSafetyLevel', () => {
  it('reads the verdict the guide leads with', () => {
    expect(petSafetyLevel('Toxic to cats and dogs if chewed (calcium oxalate crystals)')).toBe(
      'toxic'
    );
    expect(petSafetyLevel('Mildly toxic to cats and dogs if eaten')).toBe('caution');
    expect(petSafetyLevel('Non-toxic to cats and dogs (per the ASPCA) — pet-safe')).toBe('safe');
  });

  it('does not let the word "toxic" inside a non-toxic sentence flip the verdict', () => {
    // Spider plant's real line. A `includes('toxic')` classifier files the
    // ASPCA's own non-toxic ruling under "toxic".
    expect(
      petSafetyLevel('Non-toxic to cats and dogs (per the ASPCA), though cats love chewing it')
    ).toBe('safe');
  });

  it('refuses to guess when the line does not open with a verdict', () => {
    expect(petSafetyLevel('Ask your vet before bringing this one home')).toBe('unclear');
  });
});

describe('PET_SAFE_SPECIES', () => {
  it('covers every care guide exactly once', () => {
    expect(PET_SAFE_SPECIES).toHaveLength(CARE_GUIDES.length);
    expect(new Set(PET_SAFE_SPECIES.map((s) => s.slug))).toEqual(
      new Set(CARE_GUIDES.map((g) => g.slug))
    );
  });

  it('quotes each guide’s toxicity line verbatim', () => {
    for (const species of PET_SAFE_SPECIES) {
      const guide = CARE_GUIDES.find((g) => g.slug === species.slug)!;
      expect(species.verdict).toBe(guide.quickFacts.toxicity);
      expect(species.commonName).toBe(guide.commonName);
      expect(species.scientificName).toBe(guide.scientificName);
    }
  });

  it('never groups a guide that is not non-toxic under the safe heading', () => {
    const safe = PET_SAFE_GROUPS.find((g) => g.id === 'safe');
    for (const species of safe?.species ?? []) {
      expect(species.verdict.toLowerCase().startsWith('non-toxic')).toBe(true);
    }
  });

  it('keeps "mildly toxic" out of the safe group', () => {
    const snakePlant = PET_SAFE_SPECIES.find((s) => s.slug === 'snake-plant')!;
    expect(snakePlant.level).toBe('caution');
    const safe = PET_SAFE_GROUPS.find((g) => g.id === 'safe');
    expect(safe?.species.some((s) => s.slug === 'snake-plant')).toBe(false);
  });

  it('renders in the order the groups are laid out, so ItemList positions match the DOM', () => {
    expect(PET_SAFE_SPECIES).toEqual(PET_SAFE_GROUPS.flatMap((g) => g.species));
  });
});

describe('PET_SAFETY_POSTS', () => {
  // The titles are copied rather than imported, to keep the blog prose chunk
  // out of the /pet-safe bundle. This is the check that keeps the copy honest.
  it('matches the real blog posts, slug and title', () => {
    for (const ref of Object.values(PET_SAFETY_POSTS)) {
      const post = POSTS.find((p) => p.slug === ref.slug);
      expect(post, `no blog post with slug ${ref.slug}`).toBeDefined();
      expect(post!.title).toBe(ref.title);
    }
  });
});
