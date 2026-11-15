import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/services/petToxicityService', () => ({
  petToxicityService: { lookup: vi.fn() },
}));

import i18n, { ensureLanguageCatalog } from '@/i18n';
import { LandingPage } from '@/features/landing/LandingPage';
import { CareIndex } from '@/features/care/CareIndex';
import { HolidayCareGuides } from '@/features/care/HolidayCareGuides';
import { HOLIDAY_CARE_GUIDES, HOLIDAY_CARE_GUIDES_ON } from '@/features/care/holidayGuideList';
import { findCareGuide } from '@/features/care/careGuides';
import enCatalog from '@/i18n/locales/en/translation.json';
import esCatalog from '@/i18n/locales/es/translation.json';

/**
 * The "Holiday plants" care-guide list is built and switched off until its
 * heading is approved (holidayGuideList.ts). These pin both halves: off, it
 * renders nothing on the pages it is placed on; on, it is the list it says.
 */
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

function inApp(element: React.ReactElement): HTMLElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>
  ).container;
}

/** Words that state or imply a verdict, as in smallTrafficLinks.test.tsx. */
const VERDICT_WORDS =
  /\b(safe|safer|safety|unsafe|harmless|non-?toxic|toxic|poison\w*|danger\w*|seguro|segura|t[oó]xic[oa])\b/iu;

describe('the holiday care-guide list', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('es');
  });

  it('is switched off until its heading is approved', () => {
    expect(HOLIDAY_CARE_GUIDES_ON).toBe(false);
  });

  it.each([
    ['home', () => inApp(<LandingPage />), 'landing-holiday-care'],
    ['/care', () => inApp(<CareIndex />), 'care-index-holiday'],
  ])('renders nothing on %s while off', (_name, renderIt, id) => {
    const root = renderIt();
    expect(root.querySelector(`#${id}`)).toBeNull();
    expect(root.querySelector(`[aria-labelledby="${id}"]`)).toBeNull();
  });

  it('when on, links each guide under its own name', () => {
    const root = inApp(<HolidayCareGuides id="holiday-test" on />);
    const anchors = Array.from(root.querySelectorAll('a'));
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(
      HOLIDAY_CARE_GUIDES.map((g) => `/care/${g.slug}`)
    );
    for (const [i, g] of HOLIDAY_CARE_GUIDES.entries()) {
      const guide = findCareGuide(g.slug);
      expect(guide, g.slug).toBeDefined();
      expect(anchors[i]?.textContent, g.slug).toBe(guide?.commonName);
    }
    expect(root.textContent ?? '').not.toMatch(VERDICT_WORDS);
  });

  it('when on, shows Spanish names on a Spanish page, with no verdict in them', async () => {
    await i18n.changeLanguage('es');
    const root = inApp(<HolidayCareGuides id="holiday-test" on />);
    const anchors = Array.from(root.querySelectorAll('a'));
    expect(anchors).toHaveLength(HOLIDAY_CARE_GUIDES.length);
    for (const [i, g] of HOLIDAY_CARE_GUIDES.entries()) {
      const label = anchors[i]?.textContent ?? '';
      expect(label, g.slug).not.toMatch(/^careHolidayGuides\./);
      expect(label, g.slug).not.toBe(findCareGuide(g.slug)?.commonName);
    }
    expect(root.textContent ?? '').not.toMatch(VERDICT_WORDS);
  });

  it('when on, uses the existing "Holiday plants" label, in both languages', async () => {
    const heading = () => document.getElementById('holiday-test')?.textContent;
    inApp(<HolidayCareGuides id="holiday-test" on />);
    expect(heading()).toBe(enCatalog.petSafeSpecies.holidayHeading);
    cleanup();
    await i18n.changeLanguage('es');
    inApp(<HolidayCareGuides id="holiday-test" on />);
    expect(heading()).toBe(esCatalog.petSafeSpecies.holidayHeading);
  });

  it('includes the holiday guides the 2026-11-15 report asked for', () => {
    const slugs = HOLIDAY_CARE_GUIDES.map((g) => g.slug);
    for (const slug of ['paperwhite', 'rosemary', 'amaryllis', 'cyclamen']) {
      expect(slugs).toContain(slug);
    }
  });
});
