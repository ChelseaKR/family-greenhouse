import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/config/commercialStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/commercialStatus')>()),
  PUBLIC_REGISTRATION_AVAILABLE: true,
}));

vi.mock('@/services/petToxicityService', () => ({
  petToxicityService: { lookup: vi.fn() },
}));

import i18n, { ensureLanguageCatalog } from '@/i18n';
import { LandingPage } from '@/features/landing/LandingPage';
import { CareGuidePage } from '@/features/care/CareGuidePage';
import { PetSafePlantPage } from '@/features/petsafe/PetSafePlantPage';
import { BlogPost } from '@/features/blog/BlogPost';
import { POSTS } from '@/features/blog/posts';
import { PublicShell } from '@/components/PublicShell';

/**
 * One header and one footer on every public page (IA decisions D1 and D2,
 * 2026-11-21). Before, the home page had its own header (Features, Plans,
 * Log in, "Sign up free") and footer (four groups, no Help, Support or Delete
 * account), and every other page another (Care guides, Blog, Plans, "Try the
 * app →", no Log in; one row of links without the pet-safe checker or
 * Contact). Neither header linked the pet-safety hub.
 *
 * The check compares what a reader can follow, as [label, href] pairs, so a
 * page that grows its own header again fails here, not in a review.
 */
function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/care/:slug" element={<CareGuidePage />} />
          <Route path="/pet-safe/:slug" element={<PetSafePlantPage />} />
          <Route path="/blog/:slug" element={<BlogPost />} />
          <Route path="/status" element={<PublicShell>status</PublicShell>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

type Pair = [label: string, href: string | null];
const pairs = (root: Element): Pair[] =>
  Array.from(root.querySelectorAll('a')).map((a) => [
    (a.getAttribute('aria-label') ?? a.textContent ?? '').trim(),
    a.getAttribute('href'),
  ]);

const siteHeader = (container: HTMLElement) => {
  const header = container.querySelector('header');
  expect(header).not.toBeNull();
  return header!;
};
const siteFooter = (container: HTMLElement) => {
  const footers = container.querySelectorAll('footer');
  expect(footers).toHaveLength(1);
  return footers[0]!;
};

/** The header's links with the page's plant taken off the sign-up href. */
const headerPairs = (container: HTMLElement): Pair[] =>
  pairs(siteHeader(container)).map(([label, href]) => [
    label,
    href?.startsWith('/register') ? '/register' : href,
  ]);
/** The footer's links with the home page's in-page anchor written as from elsewhere. */
const footerPairs = (container: HTMLElement): Pair[] =>
  pairs(siteFooter(container)).map(([label, href]) => [
    label,
    href === '#features' ? '/#features' : href,
  ]);

const PAGES = ['/', '/care/peperomia', '/pet-safe/aloe-vera', `/blog/${POSTS[0]!.slug}`, '/status'];

describe('one site header and one site footer', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('es');
  });
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
  });

  it('gives the home page and the content pages the same header', () => {
    const home = headerPairs(renderAt('/'));
    cleanup();
    expect(home).toEqual([
      ['Family Greenhouse, Grow together, home', '/'],
      ['Care guides', '/care'],
      ['Pets and plants', '/pet-safe'],
      ['Blog', '/blog'],
      ['Plans', '/pricing'],
      ['Log in', '/login'],
      ['Sign up free', '/register'],
      // The phone Menu: Log in first, then the same four places.
      ['Log in', '/login'],
      ['Care guides', '/care'],
      ['Pets and plants', '/pet-safe'],
      ['Blog', '/blog'],
      ['Plans', '/pricing'],
    ]);
    for (const path of PAGES.slice(1)) {
      expect(headerPairs(renderAt(path)), path).toEqual(home);
      cleanup();
    }
  });

  it('no longer offers "Try the app" or the home page’s Features anchor in the header', () => {
    for (const path of PAGES) {
      const header = siteHeader(renderAt(path));
      expect(within(header).queryByText(/try the app/i), path).toBeNull();
      expect(header.querySelector('a[href="#features"]'), path).toBeNull();
      cleanup();
    }
  });

  it('gives every page the same four-group footer, with the links each one lacked', () => {
    const home = renderAt('/');
    const headings = Array.from(siteFooter(home).querySelectorAll('h2')).map((h) => h.textContent);
    expect(headings).toEqual(['Learn', 'Product', 'Company', 'Legal']);
    const homeLinks = footerPairs(home);
    cleanup();
    // Help, Support and Delete account were missing on the home page; the
    // pet-safe checker and Contact on every other page.
    for (const pair of [
      ['Help', '/help'],
      ['Support', '/support'],
      ['Delete account', '/account-deletion'],
      ['Pet-safe plant checker', '/pet-safe'],
      ['Contact', 'mailto:hello@familygreenhouse.net'],
      ['Features', '/#features'],
    ] as Pair[]) {
      expect(homeLinks).toContainEqual(pair);
    }
    for (const path of PAGES.slice(1)) {
      expect(footerPairs(renderAt(path)), path).toEqual(homeLinks);
      cleanup();
    }
  });

  it('keeps Features an in-page anchor on the home page only', () => {
    expect(siteFooter(renderAt('/')).querySelector('a[href="#features"]')).not.toBeNull();
    cleanup();
    expect(
      siteFooter(renderAt('/care/peperomia')).querySelector('a[href="/#features"]')
    ).not.toBeNull();
  });

  it('carries the guide’s plant in the header button exactly as before', () => {
    const header = siteHeader(renderAt('/care/zz-plant'));
    expect(within(header).getByRole('link', { name: 'Sign up free' })).toHaveAttribute(
      'href',
      '/register?plant=zz-plant'
    );
  });

  it('reads in Spanish with the existing catalog words', async () => {
    await i18n.changeLanguage('es');
    const container = renderAt('/care/peperomia');
    const header = siteHeader(container);
    for (const label of ['Guías de cuidado', 'Mascotas y plantas', 'Planes', 'Entrar']) {
      expect(within(header).getAllByRole('link', { name: label }).length, label).toBeGreaterThan(0);
    }
    expect(within(header).getByRole('link', { name: 'Regístrate gratis' })).toBeInTheDocument();
    const headings = Array.from(siteFooter(container).querySelectorAll('h2')).map(
      (h) => h.textContent
    );
    expect(headings).toEqual(['Aprende', 'Producto', 'Empresa', 'Aviso legal']);
  });

  it('negative control: a page with a header of its own would fail the comparison', () => {
    const home = headerPairs(renderAt('/'));
    cleanup();
    const container = renderAt('/care/peperomia');
    expect(headerPairs(container)).toEqual(home);
    // The old content-page header had no pet-safe hub link: take it out again.
    siteHeader(container)
      .querySelectorAll('a[href="/pet-safe"]')
      .forEach((a) => a.remove());
    expect(headerPairs(container)).not.toEqual(home);
  });
});
