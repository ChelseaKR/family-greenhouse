import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { LandingPage } from '@/features/landing/LandingPage';

/**
 * The pet-safe checker (/pet-safe) is the site's cited, no-signup front door,
 * and the home page is where most visitors arrive. Before this test the home
 * page linked the care guides and the blog but never /pet-safe, so the
 * checker was reachable only from inside other pages.
 *
 * Since the one site header (2026-11-21) it is also the header's "Pets and
 * plants" link, once in the wide-screen row and once in the phone Menu.
 */
function renderLanding(): HTMLElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

const petSafeLinks = (root: ParentNode) =>
  Array.from(root.querySelectorAll('a')).filter((a) => a.getAttribute('href') === '/pet-safe');

describe('the home page links the pet-safe checker', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('es');
  });
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
  });

  it('links /pet-safe from the header, the care band and the footer, with real words', () => {
    const container = renderLanding();
    const links = petSafeLinks(container);
    // Header row + header Menu + care band + footer.
    expect(links.length).toBe(4);
    expect(links.some((a) => container.querySelector('footer')?.contains(a))).toBe(true);
    expect(
      links.filter((a) => container.querySelector('header')?.contains(a)).map((a) => a.textContent)
    ).toEqual(['Pets and plants', 'Pets and plants']);
    for (const a of links)
      expect(a.textContent?.replace(/→/g, '').trim().length).toBeGreaterThan(8);
  });

  it('the Spanish home page links it too, in Spanish', async () => {
    await i18n.changeLanguage('es');
    const links = petSafeLinks(renderLanding());
    expect(links.length).toBe(4);
    expect(links.map((a) => a.textContent)).toContain('Mascotas y plantas');
    expect(links.map((a) => a.textContent)).not.toContain('Pet-safe plant checker');
  });

  it('negative control: with the links removed the check reports none', () => {
    const container = renderLanding();
    const before = petSafeLinks(container);
    expect(before.length).toBeGreaterThan(0);
    before.forEach((a) => a.remove());
    // The sabotage applied: fewer links than before, and the check now fails.
    expect(petSafeLinks(container).length).toBe(0);
  });
});
