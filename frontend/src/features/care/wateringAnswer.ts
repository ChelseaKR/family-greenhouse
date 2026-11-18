import type { CareGuide } from './careGuides';

/**
 * The guide's own short answer to "how often should I water <plant>?": the
 * FAQ entry that asks it. Every published guide has one, 26 to 56 words long
 * (careGuides test), which is the size of answer a search results page quotes.
 *
 * The care page prints it as the first paragraph under "How often to water
 * <plant>", so the searched question is followed directly by one complete
 * paragraph that answers it. Before, that heading led into the longer
 * method-and-sources paragraph, and this answer sat at the bottom of the page
 * inside the FAQ list. The text is the FAQ answer verbatim, so the page and
 * the FAQPage markup cannot drift apart.
 *
 * Returns undefined rather than a stand-in when a guide has no such entry, so
 * the page shows nothing instead of a borrowed answer.
 */
export function wateringAnswer(guide: CareGuide): string | undefined {
  return guide.faqs.find((f) => /^how often should i water\b/i.test(f.q))?.a;
}
