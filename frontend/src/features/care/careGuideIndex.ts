import type { CareGuide } from './careGuides';

/**
 * The few fields of a care guide that pages listing several guides need: the
 * /care index, the "Related plants" links on a guide, and the /pet-safe list.
 *
 * Everything else in a guide (the sections, FAQs, sources and meta copy) is
 * read only by that guide's own page, so the browser build keeps it out of
 * the JavaScript bundle and loads it per guide. See careGuideContent.ts.
 */
export interface CareGuideIndexEntry {
  slug: string;
  commonName: string;
  scientificName: string;
  quickFacts: Pick<CareGuide['quickFacts'], 'water' | 'toxicity'>;
}

export function toCareGuideIndexEntry(guide: CareGuide): CareGuideIndexEntry {
  return {
    slug: guide.slug,
    commonName: guide.commonName,
    scientificName: guide.scientificName,
    quickFacts: { water: guide.quickFacts.water, toxicity: guide.quickFacts.toxicity },
  };
}
