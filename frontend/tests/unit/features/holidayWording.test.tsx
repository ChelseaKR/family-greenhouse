import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { CareGuidePage } from '@/features/care/CareGuidePage';
import { CARE_GUIDES, findCareGuide } from '@/features/care/careGuides';

/**
 * Search wording approved on 2026-11-17 (growth/traffic-2026-11-17), pinned
 * word for word. Each block is one approved item. No fact changes in any of
 * them: every new sentence restates one the guide already published with a
 * named source, and the blocks check that against the guide's own text.
 */
afterEach(cleanup);

function renderGuide(slug: string): HTMLElement {
  return render(
    <MemoryRouter initialEntries={[`/care/${slug}`]}>
      <Routes>
        <Route path="/care/:slug" element={<CareGuidePage />} />
      </Routes>
    </MemoryRouter>
  ).container;
}

function descriptionTag(): string | null {
  return document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;
}

describe('poinsettia: the title and description lead with the watering answer', () => {
  const TITLE = 'How Often to Water a Poinsettia: When the Surface Is Dry';
  const DESCRIPTION =
    'Water a poinsettia when the soil surface is dry to the touch, then let it drain. Check it daily. Plus the light it needs and keeping it past the holidays.';

  it('carries the approved title and description, within the display budgets', () => {
    const guide = findCareGuide('poinsettia')!;
    expect(guide.metaTitle).toBe(TITLE);
    expect(guide.metaDescription).toBe(DESCRIPTION);
    expect(TITLE.length).toBeLessThanOrEqual(60);
    expect(DESCRIPTION.length).toBeLessThanOrEqual(155);
  });

  it('publishes them on the page', () => {
    renderGuide('poinsettia');
    expect(document.title).toBe(TITLE);
    expect(descriptionTag()).toBe(DESCRIPTION);
  });

  it('keeps the heading: the optional longer one was not approved', () => {
    const guide = findCareGuide('poinsettia')!;
    expect(guide.heading).toBeUndefined();
    expect(renderGuide('poinsettia').querySelector('h1')?.textContent).toBe('Poinsettia care');
  });

  it('says only what the guide’s own cited watering answer says', () => {
    const guide = findCareGuide('poinsettia')!;
    const answer = guide.faqs[0]!.a;
    expect(guide.quickFacts.water).toContain('When the soil surface is dry to the touch');
    expect(answer).toContain('When the soil surface is dry to the touch; check it daily.');
    expect(answer).toContain('let it drain completely');
    // No day count: the extension sources give none, and the answer says so.
    expect(answer).toContain('The extension sources give no fixed number of days.');
    expect(DESCRIPTION).not.toMatch(/\d/);
  });

  it('is unique, and dated the day it changed', () => {
    const guide = findCareGuide('poinsettia')!;
    expect(CARE_GUIDES.filter((g) => g.metaTitle === TITLE)).toHaveLength(1);
    expect(CARE_GUIDES.filter((g) => g.metaDescription === DESCRIPTION)).toHaveLength(1);
    expect(guide.reviewed).toBe('2026-11-03');
    expect(guide.updated).toBe('2026-11-17');
  });
});

describe('Christmas cactus: the title leads with the watering question', () => {
  const TITLE = 'How Often to Water a Christmas Cactus: Top Inch Dry';

  it('carries the approved title, within the display budget, and publishes it', () => {
    const guide = findCareGuide('christmas-cactus')!;
    expect(guide.metaTitle).toBe(TITLE);
    expect(TITLE.length).toBeLessThanOrEqual(60);
    expect(CARE_GUIDES.filter((g) => g.metaTitle === TITLE)).toHaveLength(1);
    renderGuide('christmas-cactus');
    expect(document.title).toBe(TITLE);
  });

  it('leaves the description and the heading as they were', () => {
    const guide = findCareGuide('christmas-cactus')!;
    expect(guide.metaDescription).toBe(
      'Water a Christmas cactus when the top inch of soil is dry, in bright, filtered light. Why it drops buds and how to make it bloom again.'
    );
    expect(guide.heading).toBe('How to care for a Christmas cactus');
    expect(renderGuide('christmas-cactus').querySelector('h1')?.textContent).toBe(
      'How to care for a Christmas cactus'
    );
  });

  it('says only what the guide’s own cited water line says', () => {
    const guide = findCareGuide('christmas-cactus')!;
    expect(guide.quickFacts.water).toBe('When the top inch of soil is dry; water thoroughly');
    expect(guide.faqs[0]!.a).toContain('When the top inch of soil is dry');
    expect(guide.reviewed).toBe('2026-11-03');
    expect(guide.updated).toBe('2026-11-17');
  });
});

describe('winter watering: one new question on six guides', () => {
  /** Slug, question, answer: the approved text, word for word. */
  const WINTER = [
    [
      'snake-plant',
      'How often should I water a snake plant in winter?',
      'Far less than in summer. North Carolina State Extension puts it at once every one to two months. If you are not sure whether it needs water, it almost certainly does not.',
    ],
    [
      'jade-plant',
      'How often should I water a jade plant in winter?',
      'Keep it on the dry side in winter, when it is semi-dormant. The extension sources give no fixed number of days. Wisconsin says overwatering drops the leaves and rots the stem.',
    ],
    [
      'ponytail-palm',
      'How often should I water a ponytail palm in winter?',
      'Much less than in summer. North Carolina State Extension says to reduce watering greatly in winter. Wisconsin explains why: in the wild it gets summer rain and stays dry through most of the winter, and its swollen base stores water.',
    ],
    [
      'hoya',
      'How often should I water a hoya in winter?',
      'Much less than in summer. UF says to water very sparingly in winter or in lower light. Let the mix dry almost completely first.',
    ],
    [
      'haworthia',
      'How often should I water a haworthia in winter?',
      'Less often than in summer. University of Wisconsin–Madison Extension says a haworthia in a well-drained mix can be watered weekly in summer and less often in winter. Let the mix dry before you water again.',
    ],
    [
      'boston-fern',
      'How often should I water a Boston fern in winter?',
      'Less than the rest of the year. North Carolina State Extension says the plant is dormant in winter and overwatering can lead to root rot. The extension sources give no fixed number of days, so check by touch.',
    ],
  ] as const;

  /**
   * The sentences already in each guide that the new answer restates. Each
   * is in the guide's watering section or its first FAQ answer, beside the
   * source it names, so the new answer adds no fact.
   */
  const ALREADY_SAID: Record<string, readonly string[]> = {
    'snake-plant': [
      'North Carolina State Extension puts it at once every one to two months.',
      'If you are not sure whether it needs water, it almost certainly does not.',
    ],
    'jade-plant': [
      'In winter, when it is semi-dormant, keep it on the dry side.',
      'The extension sources give no fixed number of days',
      'Wisconsin says overwatering drops leaves and rots the stem',
    ],
    'ponytail-palm': [
      'NC State says to reduce watering greatly',
      'in the wild it gets summer rain and stays dry through most of the winter, and its swollen base stores water',
    ],
    hoya: [
      'In winter, or in lower light, water much less: UF says very sparingly.',
      'not again until the mix has dried almost completely',
    ],
    haworthia: [
      'University of Wisconsin–Madison Extension says that in a well-drained mix a haworthia can be watered weekly in the summer, and less often in winter.',
      'let the potting mix dry before you water again',
    ],
    'boston-fern': [
      'North Carolina State Extension says the plant is dormant then and overwatering can lead to root rot.',
      'The extension sources give no fixed number of days, so check by touch.',
    ],
  };

  it.each(WINTER)('%s: has the approved question and answer, second in its FAQ', (slug, q, a) => {
    const guide = findCareGuide(slug)!;
    expect(guide.faqs[1]).toEqual({ q, a });
    expect(guide.faqs.filter((f) => f.q === q)).toHaveLength(1);
  });

  it.each(WINTER)('%s: the answer restates what the guide already says', (slug, _q, a) => {
    const guide = findCareGuide(slug)!;
    const before = [...guide.sections.watering, guide.faqs[0]!.a].join(' ');
    for (const sentence of ALREADY_SAID[slug]!) expect(before, sentence).toContain(sentence);
    // Every source the answer names is one the guide cites or already names.
    const cited = guide.careSources.map((s) => s.publisher).join(' | ');
    if (a.includes('North Carolina State Extension')) {
      expect(cited).toContain('North Carolina State Extension');
    }
    if (a.includes('University of Wisconsin–Madison Extension')) {
      expect(cited).toContain('University of Wisconsin–Madison Extension');
    }
    if (a.includes('Wisconsin ')) expect(cited).toContain('Wisconsin');
    if (a.includes('UF ')) expect(cited).toContain('UF/IFAS');
  });

  it.each(WINTER)(
    '%s: the page shows it, marks it up, and keeps its short answer',
    (slug, q, a) => {
      const guide = findCareGuide(slug)!;
      const root = renderGuide(slug);
      const shown = Array.from(root.querySelectorAll('article dl dt')).map((dt) => dt.textContent);
      expect(shown).toContain(q);
      const script = document.querySelector(
        'script[type="application/ld+json"][data-use-meta-tags]'
      );
      const graph = JSON.parse(script!.textContent!)['@graph'] as Record<string, unknown>[];
      const faq = graph.find((n) => n['@type'] === 'FAQPage') as {
        mainEntity: { name: string; acceptedAnswer: { text: string } }[];
      };
      expect(faq.mainEntity.find((e) => e.name === q)?.acceptedAnswer.text).toBe(a);
      // The paragraph under "How often to water" is still the year-round
      // answer: the winter question must not take its place.
      expect(root.querySelector('[data-testid="care-water-answer"]')?.textContent).toBe(
        guide.faqs[0]!.a
      );
      expect(guide.faqs[0]!.q.endsWith('in winter?')).toBe(false);
    }
  );

  it('dates the six guides the day they changed, and no other guide gained the question', () => {
    const slugs = WINTER.map(([slug]) => slug as string);
    for (const slug of slugs) expect(findCareGuide(slug)!.updated, slug).toBe('2026-11-17');
    // Alocasia already asked its own winter question; it is not one of these.
    const asking = CARE_GUIDES.filter((g) =>
      g.faqs.some((f) => f.q.startsWith('How often should I water') && f.q.endsWith('in winter?'))
    ).map((g) => g.slug);
    expect(asking.sort()).toEqual([...slugs].sort());
  });
});
