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
