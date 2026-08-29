/**
 * Blog post metadata, split out of `index.ts` so it can be read WITHOUT
 * pulling in the six TSX post bodies. `scripts/prerender.mjs` and
 * `scripts/build-sitemap.mjs` run under plain Node and import this module
 * directly; they cannot import `index.ts`, which imports React components.
 *
 * Keep this module free of relative imports and of `@/` aliases, and keep any
 * import it does grow extension-qualified — Node's ESM resolver adds no
 * extensions. `index.ts` joins these entries to their components.
 */
export interface BlogPostMeta {
  slug: string;
  title: string;
  /** Listing preview text on /blog, and the meta description when it is short
   *  enough to survive a search result intact. */
  description: string;
  /**
   * Meta description, when the listing preview runs longer than a search
   * snippet shows. Same claims, fewer words — Google truncates around 160
   * characters, so four of these posts were shipping a description whose
   * second half no search result could ever display.
   */
  metaDescription?: string;
  /** ISO date string. Drives sort order on the index. */
  date: string;
  /** Reading time in minutes — rough estimate, shown on the index. */
  readingMinutes: number;
  /** Basename of the TSX body in this directory. `index.ts` resolves it to a
   *  component; `build-sitemap.mjs` dates the route from that file's history. */
  body: string;
}

export const POST_META: BlogPostMeta[] = [
  {
    slug: 'how-to-remember-to-water-plants',
    title: 'How to actually remember to water your plants',
    description:
      'Why most people forget to water their plants — and the three systems that actually work, ranked from worst to best.',
    date: '2026-05-05',
    readingMinutes: 5,
    body: 'remembering-to-water',
  },
  {
    slug: 'sharing-plant-care-without-becoming-the-nag',
    title: 'Sharing plant care without becoming the household nag',
    description:
      "Almost every couple I've talked to has the same plant-care argument. Here's the structural fix that doesn't require either of you to remember more.",
    date: '2026-05-13',
    readingMinutes: 6,
    body: 'sharing-plant-care',
  },
  {
    slug: 'low-maintenance-houseplants-for-forgetful-people',
    title: 'Seven houseplants that survive being forgotten',
    description:
      "Most 'low maintenance plant' lists are repeats of each other. Here are seven that genuinely fail in recoverable ways — ranked by how forgiving they are when life gets busy.",
    metaDescription:
      'Seven houseplants that fail in recoverable ways, ranked by how forgiving each one is when life gets busy.',
    date: '2026-05-21',
    readingMinutes: 5,
    body: 'low-water-plants',
  },
  {
    slug: 'how-to-move-plants-without-killing-them',
    title: 'How to move with houseplants without killing them',
    description:
      "I've moved with thirty-seven plants three times. Here's what changed between losing eight, losing three, and losing none — plus the long-distance freeze problem nobody warns you about.",
    metaDescription:
      'What changed between losing eight plants in a move, losing three, and losing none — plus the long-distance freeze problem.',
    date: '2026-05-28',
    readingMinutes: 6,
    body: 'moving-with-plants',
  },
  {
    slug: 'pet-safe-houseplants-that-are-hard-to-kill',
    title: 'Pet-safe houseplants that are genuinely hard to kill',
    description:
      '“Pet-safe” and “hard to kill” knock out most of the plants the listicles name — pothos, ZZ, snake plant, aloe are all toxic. Here’s the shorter, honest list that clears both bars, ranked by how much neglect it forgives.',
    metaDescription:
      'Pothos, ZZ, snake plant and aloe are all toxic. The shorter, honest list of houseplants that clear both bars.',
    date: '2026-06-15',
    readingMinutes: 6,
    body: 'pet-safe-hard-to-kill',
  },
  {
    slug: 'most-common-toxic-houseplants-and-safer-swaps',
    title: 'The most common toxic houseplants (and safer swaps)',
    description:
      'A list of scary plant names is useless if your cat chews leaves. Here are the most common toxic houseplants, what each actually does, and a genuinely pet-safe plant to buy instead — grounded in ASPCA data.',
    metaDescription:
      'The most common toxic houseplants, what each one actually does, and a pet-safe plant to buy instead. Grounded in ASPCA data.',
    date: '2026-06-16',
    readingMinutes: 6,
    body: 'common-toxic-houseplants',
  },
];

/** The description a search engine should see for a post. */
export function postMetaDescription(post: BlogPostMeta): string {
  return post.metaDescription ?? post.description;
}
