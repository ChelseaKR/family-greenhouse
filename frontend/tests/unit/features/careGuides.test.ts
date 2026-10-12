import { describe, expect, it } from 'vitest';
import { CARE_GUIDES, findCareGuide } from '@/features/care/careGuides';
import { careToxicity } from '@/features/care/careToxicity';
import { petSafetyLevel } from '@/features/petsafe/petSafeSpecies';

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
      // ISO date the facts were last checked — drives `datePublished`.
      expect(g.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // ISO date the content last changed — drives `dateModified`,
      // `article:modified_time` and the sitemap's `<lastmod>`.
      expect(g.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

  it('every guide’s pet line opens with the verdict its cited source gives', () => {
    // The toxicity quick-fact is the line a pet owner trusts, and the
    // /pet-safe directory badges it by its opening words. It must say what
    // the ASPCA listing says, or "Unknown" when there is no cited verdict:
    // never a verdict nobody can trace.
    for (const g of CARE_GUIDES) {
      const { claims } = careToxicity(g);
      const level = petSafetyLevel(g.quickFacts.toxicity);
      const states = new Set([claims.cats.state, claims.dogs.state]);
      if (states.has('not-assessed')) {
        expect(g.quickFacts.toxicity, g.slug).toMatch(/^Unknown\b/);
        expect(level, g.slug).toBe('unclear');
      } else if (states.size === 1 && states.has('toxic')) {
        expect(['toxic', 'caution'], g.slug).toContain(level);
      } else if (states.size === 1 && states.has('non-toxic')) {
        expect(level, g.slug).toBe('safe');
      } else {
        // Mixed verdicts have no single opening word; none exist today.
        expect(level, g.slug).toBe('unclear');
      }
    }
  });

  it('has no hand-written pet-toxicity FAQ (the page generates the cited one)', () => {
    for (const g of CARE_GUIDES) {
      for (const faq of g.faqs) {
        expect(faq.q, `${g.slug}: ${faq.q}`).not.toMatch(/toxic|poison|safe for|pet-safe/i);
      }
    }
  });

  it('makes no pet verdict in the prose of a guide with no cited verdict', () => {
    // ZZ plant has no ASPCA listing. Its prose used to call it toxic from
    // general knowledge; the page now says "Unknown" and the prose must not
    // contradict that in either direction. Link anchors are stripped first,
    // so "[free pet-safe checker](/pet-safe)" is not read as a verdict.
    const unknown = CARE_GUIDES.filter((g) => !careToxicity(g).sourced);
    expect(unknown.map((g) => g.slug)).toEqual(['zz-plant']);
    for (const g of unknown) {
      const prose = [
        g.summary,
        g.metaTitle,
        g.metaDescription,
        ...Object.values(g.sections).flat(),
        ...g.faqs.flatMap((f) => [f.q, f.a]),
      ].map((t) => t.replace(/\[[^\]]*\]\([^)]*\)/g, ''));
      for (const text of prose) {
        expect(text, g.slug).not.toMatch(
          /\b(non-toxic|toxic|poisonous|pet-safe|calcium oxalate|safe for (cats|dogs|pets))\b/i
        );
      }
    }
  });

  it('lists three related guides that exist, excluding itself', () => {
    for (const g of CARE_GUIDES) {
      expect(g.related, g.slug).toHaveLength(3);
      expect(new Set(g.related).size, g.slug).toBe(3);
      expect(g.related, g.slug).not.toContain(g.slug);
      for (const slug of g.related) {
        expect(findCareGuide(slug), `${g.slug} -> ${slug}`).toBeDefined();
      }
    }
  });

  it('every related guide is linked from at least one other guide', () => {
    // The rotation this replaced guaranteed every guide an inbound sibling
    // link; curation must not quietly orphan one.
    const linked = new Set(CARE_GUIDES.flatMap((g) => g.related));
    for (const g of CARE_GUIDES) {
      expect(linked.has(g.slug), `${g.slug} has no inbound related link`).toBe(true);
    }
  });

  it('keeps titles and descriptions within what search results display', () => {
    for (const g of CARE_GUIDES) {
      expect(g.metaTitle.length, g.slug).toBeLessThanOrEqual(60);
      expect(g.metaDescription.length, g.slug).toBeGreaterThanOrEqual(70);
      expect(g.metaDescription.length, g.slug).toBeLessThanOrEqual(160);
    }
  });

  it('is written in American English', () => {
    const text = JSON.stringify(CARE_GUIDES);
    expect(text).not.toMatch(
      /\b(colour\w*|ageing|draughts?|draughty|diarrhoea|humour|fertiliser|behaviour|centre|metre|realise)\b/i
    );
  });
});

/**
 * Guide prose supports one inline construct, `[text](/path)`, rendered by
 * `withLinks` in CareGuidePage. Before it existed, twelve entries wrote "the
 * free pet-safe checker at /pet-safe" and the reader saw those characters
 * verbatim: the copy promised a link and the DOM had no anchor, so the
 * highest-intent page on the site got nothing from the 24 pages likeliest to
 * feed it.
 */
describe('inline links in guide prose', () => {
  const proseOf = (g: (typeof CARE_GUIDES)[number]) => [
    ...g.sections.watering,
    ...g.sections.light,
    ...g.sections.problems,
    ...g.sections.sharedCare,
    ...g.sections.honestBit,
    ...g.faqs.map((f) => f.a),
  ];

  it('never leaves a bare internal path in prose, which renders as literal text', () => {
    for (const guide of CARE_GUIDES) {
      for (const text of proseOf(guide)) {
        // A path not preceded by "](" is one no anchor will wrap.
        const bare = text.match(/(?<!]\()\/(?:pet-safe|care|blog|help|pricing)\b/g);
        expect(bare, `${guide.slug} has an unlinked path: ${bare?.join(', ')}`).toBeNull();
      }
    }
  });

  it('links /pet-safe from every guide that discusses pet toxicity', () => {
    const linked = CARE_GUIDES.filter((g) => proseOf(g).some((t) => t.includes('](/pet-safe)')));
    expect(linked.length).toBeGreaterThan(0);
    for (const guide of linked) {
      const withLink = proseOf(guide).find((t) => t.includes('](/pet-safe)'))!;
      // Descriptive anchor text, not "here" or a bare path.
      expect(withLink).toMatch(/\[free pet-safe (?:checker|tool)\]\(\/pet-safe\)/);
    }
  });
});

/**
 * `reviewed` and `updated` answer different questions and must not collapse
 * back into one. Six guides shipped a `<lastmod>` and a `dateModified` 80
 * days behind their own content because a single field was serving both.
 */
describe('CARE_GUIDES content dates', () => {
  it('never dates a change before the review it followed', () => {
    // A guide is reviewed, then edited — so `updated` is the review date or
    // later, never earlier. An earlier one means somebody mistyped a date or
    // reused the wrong field.
    for (const g of CARE_GUIDES) {
      expect(
        g.updated >= g.reviewed,
        `${g.slug}: updated ${g.updated} predates reviewed ${g.reviewed}`
      ).toBe(true);
    }
  });

  it('dates no guide in the future', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const g of CARE_GUIDES) {
      expect(g.updated <= today, `${g.slug}: updated ${g.updated} is in the future`).toBe(true);
      expect(g.reviewed <= today, `${g.slug}: reviewed ${g.reviewed} is in the future`).toBe(true);
    }
  });

  it('still records the drift the split was introduced to fix', () => {
    // If this ever drops to zero, either every guide was genuinely re-reviewed
    // after its last edit — or somebody "tidied" `updated` back onto
    // `reviewed` and re-created the bug. Six guides are known to have been
    // edited (#649, #651) long after their last review.
    const drifted = CARE_GUIDES.filter((g) => g.updated !== g.reviewed);
    expect(drifted.length).toBeGreaterThanOrEqual(6);
  });
});
