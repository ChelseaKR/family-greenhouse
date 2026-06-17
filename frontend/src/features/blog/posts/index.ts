import type { ComponentType } from 'react';
import RememberingToWater from './remembering-to-water';
import SharingPlantCare from './sharing-plant-care';
import LowWaterPlants from './low-water-plants';
import MovingWithPlants from './moving-with-plants';
import PetSafeHardToKill from './pet-safe-hard-to-kill';
import CommonToxicHouseplants from './common-toxic-houseplants';

/**
 * Blog post manifest. Adding a post means dropping a TSX file in this
 * directory, importing it here, and appending to the array. The slug is
 * the URL fragment (`/blog/<slug>`), the date is ISO-8601, and the
 * description double-duties as the meta-description and the listing
 * preview text.
 *
 * Posts ship as React components rather than markdown so:
 *  - they share the app's design tokens (no MDX runtime / theming gap),
 *  - we don't take an XSS risk on `dangerouslySetInnerHTML`,
 *  - Claude can author TSX as readily as markdown per the marketing
 *    plan's content pipeline.
 */
export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  /** ISO date string. Drives sort order on the index. */
  date: string;
  /** Reading time in minutes — rough estimate, shown on the index. */
  readingMinutes: number;
  Component: ComponentType;
}

export const POSTS: BlogPost[] = [
  {
    slug: 'how-to-remember-to-water-plants',
    title: 'How to actually remember to water your plants',
    description:
      'Why most people forget to water their plants — and the three systems that actually work, ranked from worst to best.',
    date: '2026-05-05',
    readingMinutes: 5,
    Component: RememberingToWater,
  },
  {
    slug: 'sharing-plant-care-without-becoming-the-nag',
    title: 'Sharing plant care without becoming the household nag',
    description:
      "Almost every couple I've talked to has the same plant-care argument. Here's the structural fix that doesn't require either of you to remember more.",
    date: '2026-05-13',
    readingMinutes: 6,
    Component: SharingPlantCare,
  },
  {
    slug: 'low-maintenance-houseplants-for-forgetful-people',
    title: 'Seven houseplants that survive being forgotten',
    description:
      "Most 'low maintenance plant' lists are repeats of each other. Here are seven that genuinely fail in recoverable ways — ranked by how forgiving they are when life gets busy.",
    date: '2026-05-21',
    readingMinutes: 5,
    Component: LowWaterPlants,
  },
  {
    slug: 'how-to-move-plants-without-killing-them',
    title: 'How to move with houseplants without killing them',
    description:
      "I've moved with thirty-seven plants three times. Here's what changed between losing eight, losing three, and losing none — plus the long-distance freeze problem nobody warns you about.",
    date: '2026-05-28',
    readingMinutes: 6,
    Component: MovingWithPlants,
  },
  {
    slug: 'pet-safe-houseplants-that-are-hard-to-kill',
    title: 'Pet-safe houseplants that are genuinely hard to kill',
    description:
      '“Pet-safe” and “hard to kill” knock out most of the plants the listicles name — pothos, ZZ, snake plant, aloe are all toxic. Here’s the shorter, honest list that clears both bars, ranked by how much neglect it forgives.',
    date: '2026-06-15',
    readingMinutes: 6,
    Component: PetSafeHardToKill,
  },
  {
    slug: 'most-common-toxic-houseplants-and-safer-swaps',
    title: 'The most common toxic houseplants (and safer swaps)',
    description:
      'A list of scary plant names is useless if your cat chews leaves. Here are the most common toxic houseplants, what each actually does, and a genuinely pet-safe plant to buy instead — grounded in ASPCA data.',
    date: '2026-06-16',
    readingMinutes: 6,
    Component: CommonToxicHouseplants,
  },
];

export function findPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}
