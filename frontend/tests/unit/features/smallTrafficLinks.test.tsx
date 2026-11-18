import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { LandingPage } from '@/features/landing/LandingPage';
import { CareIndex } from '@/features/care/CareIndex';
import { HelpTopicPage } from '@/features/help/HelpTopicPage';
import { PetSafePage } from '@/features/petsafe/PetSafePage';
import { PLANT_SAFETY_PAGES } from '@/features/petsafe/plantSafetyPages';
import { findPost } from '@/features/blog/posts';

vi.mock('@/services/petToxicityService', () => ({
  petToxicityService: { lookup: vi.fn() },
}));

/**
 * Two small fixes from the 2026-11-08 traffic read. URL Inspection showed the
 * two posts closest to what the product does (remembering to water, sharing
 * the chores) are in the sitemap but not indexed, and neither was linked from
 * home, /care or /help. And the two holiday plants' pet pages were one name in
 * a long list on /pet-safe and not on the home page at all.
 *
 * A pet link's words are names and nothing else. A label that says or implies
 * "safe" would be a claim made out of sight of the verdict and its citation,
 * and these two plants have opposite verdicts in the table.
 */
const HOUSEHOLD_POSTS = [
  '/blog/how-to-remember-to-water-plants',
  '/blog/sharing-plant-care-without-becoming-the-nag',
];
const HOLIDAY_PET_PAGES = ['/pet-safe/christmas-cactus', '/pet-safe/poinsettia'];

function page(element: React.ReactElement, at = '/', pattern = '/'): HTMLElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path={pattern} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

const anchorsTo = (root: ParentNode, href: string) =>
  Array.from(root.querySelectorAll('a')).filter((a) => a.getAttribute('href') === href);

/** Words that state or imply a verdict. A link label may contain none of them. */
const VERDICT_WORDS =
  /\b(safe|safer|safety|unsafe|harmless|non-?toxic|toxic|poison\w*|danger\w*|okay|ok|fine|friendly|seguro|segura|t[oó]xic[oa]|venenos[oa])\b/iu;

describe('the two household posts', () => {
  it.each([
    ['home', () => page(<LandingPage />)],
    ['/care', () => page(<CareIndex />, '/care', '/care')],
    ['/help/households', () => page(<HelpTopicPage />, '/help/households', '/help/:topicId')],
  ])('are linked from %s under their own titles', (_name, renderIt) => {
    const root = renderIt();
    for (const href of HOUSEHOLD_POSTS) {
      const [link] = anchorsTo(root, href);
      expect(link, href).toBeDefined();
      const post = findPost(href.slice('/blog/'.length));
      expect(post).toBeDefined();
      expect(link?.textContent?.trim()).toBe(post?.title);
    }
  });

  it('are in the committed sitemap', () => {
    const sitemap = readFileSync(join(process.cwd(), 'public', 'sitemap.xml'), 'utf8');
    for (const href of HOUSEHOLD_POSTS) {
      expect(sitemap).toContain(`<loc>https://familygreenhouse.net${href}</loc>`);
    }
  });
});

describe('the holiday pet pages', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('es');
  });
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
  });

  it('are linked from the home page, by name and nothing else', () => {
    const root = page(<LandingPage />);
    for (const href of HOLIDAY_PET_PAGES) {
      const [link] = anchorsTo(root, href);
      expect(link, href).toBeDefined();
      expect(link?.textContent ?? '').not.toMatch(VERDICT_WORDS);
    }
    const holidayList = anchorsTo(root, HOLIDAY_PET_PAGES[0]!)[0]?.closest('ul');
    expect(holidayList?.querySelectorAll('a')).toHaveLength(HOLIDAY_PET_PAGES.length);
    expect(holidayList?.previousElementSibling?.textContent ?? '').not.toMatch(VERDICT_WORDS);
  });

  it('keep their labels in Spanish without gaining a verdict', async () => {
    await i18n.changeLanguage('es');
    const root = page(<LandingPage />);
    for (const href of HOLIDAY_PET_PAGES) {
      const label = anchorsTo(root, href)[0]?.textContent ?? '';
      expect(label).not.toMatch(/^landing\./);
      expect(label).not.toMatch(VERDICT_WORDS);
    }
  });

  it('get their own short list on /pet-safe, with the table’s names', () => {
    const root = page(<PetSafePage />, '/pet-safe', '/pet-safe');
    const section = root.querySelector('[aria-labelledby="pet-safe-holiday-heading"]');
    expect(section).not.toBeNull();
    const anchors = Array.from(section?.querySelectorAll('a') ?? []);
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(HOLIDAY_PET_PAGES);
    for (const a of anchors) {
      const entry = PLANT_SAFETY_PAGES.find(
        (p) => `/pet-safe/${p.slug}` === a.getAttribute('href')
      );
      expect(a.textContent?.trim()).toBe(entry?.commonName);
    }
    expect(section?.textContent ?? '').not.toMatch(VERDICT_WORDS);
  });

  it('are pages the table publishes', () => {
    const published = new Set(PLANT_SAFETY_PAGES.map((p) => `/pet-safe/${p.slug}`));
    for (const href of HOLIDAY_PET_PAGES) expect(published.has(href), href).toBe(true);
  });

  it('negative controls: the verdict check and the table check can both fail', () => {
    expect('Safe for your pets').toMatch(VERDICT_WORDS);
    expect('Pet-safe holiday plants').toMatch(VERDICT_WORDS);
    expect('Es segura para mascotas').toMatch(VERDICT_WORDS);
    expect('Christmas cactus and pets').not.toMatch(VERDICT_WORDS);
    const published = new Set(PLANT_SAFETY_PAGES.map((p) => `/pet-safe/${p.slug}`));
    expect(published.has('/pet-safe/not-a-plant')).toBe(false);
  });
});
