import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { CareGuidePage } from '@/features/care/CareGuidePage';
import { HolidayCareGuides } from '@/features/care/HolidayCareGuides';
import { HOLIDAY_CARE_GUIDES } from '@/features/care/holidayGuideList';
import { CARE_GUIDE_INDEX } from '@/features/care/careGuideContent';
import { findCareGuide } from '@/features/care/careGuides';
import enCatalog from '@/i18n/locales/en/translation.json';

/**
 * The "Holiday plants" list at the foot of every care guide (2026-11-17).
 *
 * It is the list the home page and /care already show, with the heading and
 * link words approved for them on 2026-11-15; holidayCareGuides.test.tsx pins
 * those words. These pin where it sits on a guide: last, below the sign-up
 * link, on every guide, and never linking a guide to itself.
 */
afterEach(cleanup);

const SECTION = '[aria-labelledby="care-holiday-guides"]';
const HOLIDAY_SLUGS = HOLIDAY_CARE_GUIDES.map((guide) => guide.slug);

function renderGuide(slug: string): HTMLElement {
  return render(
    <MemoryRouter initialEntries={[`/care/${slug}`]}>
      <Routes>
        <Route path="/care/:slug" element={<CareGuidePage />} />
      </Routes>
    </MemoryRouter>
  ).container;
}

function holidayHrefs(root: HTMLElement): (string | null)[] {
  return Array.from(root.querySelectorAll(`${SECTION} a`)).map((a) => a.getAttribute('href'));
}

/** True when `later` comes after `earlier` in the document. */
function follows(later: Element, earlier: Element): boolean {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('the holiday list on care guides', () => {
  it('links all six holiday guides from a guide that is not one of them', () => {
    const root = renderGuide('monstera');
    expect(root.querySelector('#care-holiday-guides')?.textContent).toBe(
      enCatalog.petSafeSpecies.holidayHeading
    );
    expect(holidayHrefs(root)).toEqual(HOLIDAY_SLUGS.map((slug) => `/care/${slug}`));
    // The link words are each guide's own name, nothing else.
    expect(Array.from(root.querySelectorAll(`${SECTION} a`)).map((a) => a.textContent)).toEqual(
      HOLIDAY_SLUGS.map((slug) => findCareGuide(slug)!.commonName)
    );
  });

  it.each(HOLIDAY_SLUGS)('leaves %s out of the list on its own page', (slug) => {
    const hrefs = holidayHrefs(renderGuide(slug));
    expect(hrefs).not.toContain(`/care/${slug}`);
    expect(hrefs).toEqual(
      HOLIDAY_SLUGS.filter((other) => other !== slug).map((other) => `/care/${other}`)
    );
  });

  it('is the last thing on the page, below both sign-up links and the related plants', () => {
    const root = renderGuide('snake-plant');
    const section = root.querySelector(SECTION)!;
    expect(follows(section, root.querySelector('[data-testid="care-glance-cta"]')!)).toBe(true);
    expect(follows(section, root.querySelector('[data-testid="care-cta"]')!)).toBe(true);
    expect(follows(section, root.querySelector('[data-testid="care-sources"]')!)).toBe(true);
    const main = section.parentElement!;
    expect(main.lastElementChild).toBe(section);
  });

  it('is on every published guide, once', () => {
    for (const entry of CARE_GUIDE_INDEX) {
      const root = renderGuide(entry.slug);
      expect(root.querySelectorAll(SECTION), entry.slug).toHaveLength(1);
      expect(root.querySelectorAll('#care-holiday-guides'), entry.slug).toHaveLength(1);
      cleanup();
    }
  });

  it('adds no links when the list is switched off (negative control)', () => {
    const root = render(
      <MemoryRouter>
        <HolidayCareGuides id="care-holiday-guides" exclude="amaryllis" on={false} />
      </MemoryRouter>
    ).container;
    expect(root.querySelector(SECTION)).toBeNull();
    expect(root.querySelectorAll('a')).toHaveLength(0);
  });
});
