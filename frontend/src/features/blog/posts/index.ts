import type { ComponentType } from 'react';
import RememberingToWater from './remembering-to-water';
import SharingPlantCare from './sharing-plant-care';
import LowWaterPlants from './low-water-plants';
import MovingWithPlants from './moving-with-plants';
import PetSafeHardToKill from './pet-safe-hard-to-kill';
import CommonToxicHouseplants from './common-toxic-houseplants';
import SplitPlantCare from './split-plant-care';
import WateringWhileOnVacation from './watering-while-on-vacation';
import PlantSitterHandoff from './plant-sitter-handoff';
import NonPlantPeople from './non-plant-people';
import MergingCollections from './merging-collections';
import SignsOfOverwatering from './signs-of-overwatering';
import YellowLeaves from './yellow-leaves';
import RoomLight from './room-light';

/**
 * Blog post manifest. Adding a post means dropping a TSX file in this
 * directory, importing it here, and appending to the array. The slug is
 * the URL fragment (`/blog/<slug>`), the date is ISO-8601, and the
 * description is the listing preview text on `/blog`.
 *
 * `description` used to double-duty as the meta-description too, which is
 * why 12 of 14 ran 172-220 characters: that length reads well on an index
 * card and is truncated mid-clause in a SERP, which caps at ~160. They are
 * two different jobs with two different budgets, so `metaDescription` is
 * now a separate optional field and `description` is free to stay long.
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
  /** Listing preview text on `/blog`. Long is fine here. */
  description: string;
  /** SERP copy, <=160 chars. Falls back to `description` when absent. */
  metaDescription?: string;
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
    metaDescription:
      'Seven houseplants that genuinely survive neglect, ranked by how much forgetting each one forgives — and how they fail when you push it too far.',
    date: '2026-05-21',
    readingMinutes: 5,
    Component: LowWaterPlants,
  },
  {
    slug: 'how-to-move-plants-without-killing-them',
    title: 'How to move with houseplants without killing them',
    description:
      "I've moved with thirty-seven plants three times. Here's what changed between losing eight, losing three, and losing none — plus the long-distance freeze problem nobody warns you about.",
    metaDescription:
      'What changed between losing eight plants in a move and losing none: packing, the first week in a new home, and the freeze risk nobody warns you about.',
    date: '2026-05-28',
    readingMinutes: 6,
    Component: MovingWithPlants,
  },
  {
    slug: 'pet-safe-houseplants-that-are-hard-to-kill',
    title: 'Pet-safe houseplants that are genuinely hard to kill',
    description:
      '“Pet-safe” and “hard to kill” knock out most of the plants the listicles name — pothos, ZZ, snake plant, aloe are all toxic. Here’s the shorter, honest list that clears both bars, ranked by how much neglect it forgives.',
    metaDescription:
      'Pothos, ZZ, snake plant and aloe are all toxic. Here is the shorter, honest list of plants that clear both bars, ranked by how much neglect they forgive.',
    date: '2026-06-15',
    readingMinutes: 6,
    Component: PetSafeHardToKill,
  },
  {
    slug: 'most-common-toxic-houseplants-and-safer-swaps',
    title: 'The most common toxic houseplants (and safer swaps)',
    description:
      'A list of scary plant names is useless if your cat chews leaves. Here are the most common toxic houseplants, what each actually does, and a genuinely pet-safe plant to buy instead — grounded in ASPCA data.',
    metaDescription:
      'The most common toxic houseplants, what each one actually does to a cat or dog, and a genuinely pet-safe plant to buy instead. Grounded in ASPCA data.',
    date: '2026-06-16',
    readingMinutes: 6,
    Component: CommonToxicHouseplants,
  },
  {
    slug: 'how-to-split-plant-care-with-your-partner',
    title: 'How to split plant care with a partner or housemates',
    description:
      '“We’ll both just do it” is the one arrangement that reliably fails — two people who might water a plant water it less often than one person who knows it’s theirs. Four ways to actually divide it, and what each costs you.',
    metaDescription:
      '"We\'ll both just do it" is the arrangement that reliably fails. Four ways to actually divide plant care in a household, and what each one costs you.',
    date: '2026-06-24',
    readingMinutes: 6,
    Component: SplitPlantCare,
  },
  {
    slug: 'how-to-water-plants-while-on-vacation',
    title: 'How to keep your plants alive while you’re away',
    description:
      'Five days is a non-problem; two weeks is a real one. What actually works at each trip length, which popular hacks quietly fail, and the handover mistake that kills plants after you get home.',
    metaDescription:
      'What actually works at each trip length, which popular watering hacks quietly fail, and the handover mistake that kills plants after you get home.',
    date: '2026-07-01',
    readingMinutes: 6,
    Component: WateringWhileOnVacation,
  },
  {
    slug: 'what-to-leave-for-a-plant-sitter',
    title: 'What to actually leave for a plant sitter',
    description:
      'Plant-sitting goes wrong because the instructions were written by someone who already knows the answer. Write actions, not conditions — plus the five things to leave, and the permission slip most people forget.',
    metaDescription:
      'Write actions, not conditions. The five things to leave a plant sitter, how to word instructions they can follow, and the permission most people forget.',
    date: '2026-07-08',
    readingMinutes: 6,
    Component: PlantSitterHandoff,
  },
  {
    slug: 'plant-care-instructions-for-non-plant-people',
    title: 'Setting up plant care so a non-plant-person can help',
    description:
      'You can’t delegate noticing to someone who isn’t interested — only doing. How to hand over plants in a way that survives contact with a housemate who does not care about plants.',
    metaDescription:
      'You can only delegate doing, not noticing. How to hand over your plants so the instructions survive contact with a housemate who does not care.',
    date: '2026-07-15',
    readingMinutes: 6,
    Component: NonPlantPeople,
  },
  {
    slug: 'merging-plant-collections-when-you-move-in-together',
    title: 'Moving in together: merging two plant collections',
    description:
      'Two collections, one flat, and a caretaker gap nobody notices until something dies. Quarantine, duplicates, the awkward truth about “our” plants, and reconciling two watering schedules without an argument.',
    metaDescription:
      'Quarantine, duplicates, the awkward truth about "our" plants, and how to reconcile two watering schedules without starting an argument about it.',
    date: '2026-07-22',
    readingMinutes: 6,
    Component: MergingCollections,
  },
  {
    slug: 'signs-of-overwatering-and-how-to-fix-it',
    title: 'Signs of overwatering (and how to fix it)',
    description:
      'An overwatered plant looks exactly like a thirsty one, which is why people keep watering it. How to tell them apart in two minutes, what to do about root rot, and the shared-household version nobody warns you about.',
    metaDescription:
      'An overwatered plant looks exactly like a thirsty one. How to tell them apart in two minutes, what to do about root rot, and how to stop it recurring.',
    date: '2026-07-29',
    readingMinutes: 6,
    Component: SignsOfOverwatering,
  },
  {
    slug: 'why-are-my-plant-leaves-turning-yellow',
    title: 'Why are my plant’s leaves turning yellow?',
    description:
      'Yellow leaves are a symptom, not a diagnosis — almost everything that can go wrong produces them. Triage by pattern instead: which leaves, in what order, and what else is true.',
    metaDescription:
      'Yellow leaves are a symptom, not a diagnosis. Triage by pattern instead: which leaves yellowed, in what order, and what else is true about the plant.',
    date: '2026-08-05',
    readingMinutes: 6,
    Component: YellowLeaves,
  },
  {
    slug: 'how-much-light-does-my-room-get',
    title: 'How much light does your room actually get?',
    description:
      '“Bright indirect light” describes about one square metre of most rented flats. The shadow test, why light falls off faster than it looks, and what to do about a genuinely dark home.',
    metaDescription:
      'The shadow test for measuring indoor light, why brightness falls off faster than it looks away from a window, and what to do about a genuinely dark home.',
    date: '2026-08-12',
    readingMinutes: 6,
    Component: RoomLight,
  },
];

export function findPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}
