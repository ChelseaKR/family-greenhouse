import { describe, expect, it } from 'vitest';
import { CARE_GUIDES, findCareGuide } from '@/features/care/careGuides';

/**
 * Shape + integrity test for the programmatic species care pages
 * (`/care/:slug`). These pages are pure content data rendered by one
 * template, so the registry is the thing worth guarding: a malformed entry
 * ships a broken SEO page, and a wrong `toxicity` line does real harm to a
 * pet owner who trusts it.
 */
describe('CARE_GUIDES registry', () => {
  it('has no duplicate slugs', () => {
    const slugs = CARE_GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses kebab-case slugs', () => {
    for (const g of CARE_GUIDES) {
      expect(g.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('findCareGuide resolves every slug and rejects unknown ones', () => {
    for (const g of CARE_GUIDES) {
      expect(findCareGuide(g.slug)).toBe(g);
    }
    expect(findCareGuide('not-a-real-plant')).toBeUndefined();
  });

  it('every guide has the full content shape filled in', () => {
    for (const g of CARE_GUIDES) {
      expect(g.commonName.length).toBeGreaterThan(0);
      expect(g.scientificName.length).toBeGreaterThan(0);
      expect(g.metaTitle.length).toBeGreaterThan(0);
      expect(g.metaDescription.length).toBeGreaterThan(0);
      // ISO date for "last reviewed" + sitemap lastmod.
      expect(g.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(g.summary.length).toBeGreaterThan(20);

      for (const fact of Object.values(g.quickFacts)) {
        expect(fact.length).toBeGreaterThan(0);
      }

      for (const section of Object.values(g.sections)) {
        expect(Array.isArray(section)).toBe(true);
        expect(section.length).toBeGreaterThan(0);
        for (const para of section) {
          expect(para.length).toBeGreaterThan(20);
        }
      }

      expect(g.faqs.length).toBeGreaterThan(0);
      for (const faq of g.faqs) {
        expect(faq.q.length).toBeGreaterThan(0);
        expect(faq.a.length).toBeGreaterThan(0);
      }
    }
  });

  it('every guide surfaces a pet-toxicity verdict in its quick facts', () => {
    // The toxicity quick-fact is the line a pet owner trusts — it must
    // always state cats/dogs safety, never be left blank or generic.
    for (const g of CARE_GUIDES) {
      expect(g.quickFacts.toxicity.toLowerCase()).toMatch(/toxic|non-toxic|pet-safe|safe/);
    }
  });
});
