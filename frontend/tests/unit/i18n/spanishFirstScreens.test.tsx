/**
 * The first screens a Spanish-speaking visitor sees are Spanish (#467).
 *
 * The catalog gates cannot see this: they compare catalogs with each other, so
 * a sentence typed straight into a component — or into a module-scope array a
 * component maps over, which the hardcoded-string scanner does not read —
 * passes every one of them and renders in English on a Spanish screen. That is
 * exactly how the landing page stayed English after Spanish became reachable.
 *
 * So this renders each screen twice, in English and in Spanish, and requires
 * that no piece of visible text (or accessible name) is identical in both.
 * Anything that is legitimately the same in every language is named in
 * SAME_IN_EVERY_LOCALE, with the reason; a new English string that slips in
 * fails here, whatever file it was typed into.
 */
import type { ReactElement } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { LandingPage } from '@/features/landing/LandingPage';
import { PricingPage } from '@/features/pricing/PricingPage';
import { NotFoundPage } from '@/components/NotFoundPage';

const SAME_IN_EVERY_LOCALE = new Set([
  // Brand and proper nouns.
  'Family Greenhouse',
  'Perenual',
  'familygreenhouse.net',
  // The illustrative people in the landing page's dashboard mock-up.
  'Joyce',
  'Briki',
  'Steve',
  'Kaitlin',
  'Chelsea',
  // Genus names, used as the common name in Spanish too.
  'Monstera',
  'Pothos',
  // `publicShell.blog`, listed as intentionallyEqual in translation.todo.json.
  'Blog',
  // The legacy beta badge: the same word in Spanish, and production builds
  // hide it anyway (VITE_BETA_MODE: 'false' in cd-production.yml).
  'Beta',
]);

const hasWords = (text: string) => /\p{L}{2,}/u.test(text);

/** Every visible text node and every aria-label, trimmed. */
function textsOf(container: HTMLElement): Set<string> {
  const found = new Set<string>();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (hasWords(text)) found.add(text);
  }
  for (const element of container.querySelectorAll('[aria-label]')) {
    const label = element.getAttribute('aria-label')?.trim() ?? '';
    if (hasWords(label)) found.add(label);
  }
  return found;
}

async function renderIn(lng: 'en' | 'es', ui: () => ReactElement) {
  await i18n.changeLanguage(lng);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui()}</MemoryRouter>
    </QueryClientProvider>
  );
  const texts = textsOf(container);
  const title = document.title;
  cleanup();
  return { texts, title };
}

const SCREENS: Array<[string, () => ReactElement]> = [
  ['the landing page', () => <LandingPage />],
  ['the pricing page', () => <PricingPage />],
  ['the 404 page', () => <NotFoundPage />],
];

describe('Spanish-speaking visitors’ first screens', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('es');
  });

  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  for (const [name, ui] of SCREENS) {
    it(`${name} has no English left in Spanish`, async () => {
      const english = await renderIn('en', ui);
      const spanish = await renderIn('es', ui);

      // Floors, so an empty render cannot pass by having nothing to compare.
      expect(english.texts.size, `${name} rendered no English text at all`).toBeGreaterThan(2);
      expect(spanish.texts.size, `${name} rendered no Spanish text at all`).toBeGreaterThan(2);

      const untranslated = [...spanish.texts].filter(
        (text) => english.texts.has(text) && !SAME_IN_EVERY_LOCALE.has(text)
      );
      expect(untranslated, `${name}: visible text identical in en and es`).toEqual([]);
      expect(spanish.title, `${name}: document title`).not.toBe(english.title);
    });
  }
});
