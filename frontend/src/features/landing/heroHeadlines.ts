/**
 * The landing hero headline for each A/B variant, split into the three parts
 * the hero renders (the middle one is set in italic primary).
 *
 * It lives in its own module, free of relative imports and of `@/` aliases, so
 * that `src/config/publicRoutes.ts` can state the prerendered `<h1>` for `/`
 * BY IMPORTING IT rather than by repeating the words. The headline is A/B
 * tested, so there is no single rendered h1; the shell serves variant A (the
 * control) and this import is what keeps the two from drifting apart.
 */
export interface HeroHeadline {
  pre: string;
  emphasis: string;
  post: string;
}

export const HERO_HEADLINES: Record<'A' | 'B', HeroHeadline> = {
  A: { pre: '“I thought ', emphasis: 'you', post: ' watered it.”' },
  B: { pre: 'Keep ', emphasis: 'every', post: ' plant alive.' },
};

/** The headline as one string, the way a crawler reads the rendered h1. */
export function headlineText(headline: HeroHeadline): string {
  return `${headline.pre}${headline.emphasis}${headline.post}`;
}
