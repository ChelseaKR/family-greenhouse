import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/services/petToxicityService', () => ({
  petToxicityService: { lookup: vi.fn() },
}));

import i18n, { ensureLanguageCatalog } from '@/i18n';
import { LandingPage } from '@/features/landing/LandingPage';
import { BlogPost } from '@/features/blog/BlogPost';
import { POSTS, findPost } from '@/features/blog/posts';
import { findCareGuide } from '@/features/care/careGuides';
import REDIRECTS from '@/config/redirects.json';

/**
 * The approved 2026-11-15 search fixes (fg-seo-data-2026-11-15, actions 4 and
 * 5), pinned:
 *
 *  - Guides Google had not crawled get links from pages it crawls and shows:
 *    the home page, the monstera and aloe vera guides and the overwatering
 *    post. Every link's words are the guide's own name; no sentence or heading
 *    was added to carry them.
 *  - The three yellow-leaves posts are one URL. The overwatering post had the
 *    most search impressions and is indexed, so it stays; the other two answer
 *    a 301 to it (src/config/redirects.json, served by spa-router.js).
 */
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

const CANONICAL = '/blog/signs-of-overwatering-and-how-to-fix-it';
const MERGED = ['why-are-my-plant-leaves-turning-yellow', 'do-yellow-leaves-mean-overwatering'];

function landing(): HTMLElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

const anchorsTo = (root: ParentNode, href: string) =>
  Array.from(root.querySelectorAll('a')).filter((a) => a.getAttribute('href') === href);

describe('links to guides Google had not crawled', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('es');
  });

  it('the monstera and aloe vera guides list them as related plants', () => {
    expect(findCareGuide('monstera')?.related).toContain('sago-palm');
    expect(findCareGuide('aloe-vera')?.related).toContain('blue-echeveria');
    expect(findCareGuide('aloe-vera')?.related).toContain('haworthia');
  });

  it('the home page links haworthia and rosemary by their guide names', () => {
    const root = landing();
    for (const slug of ['haworthia', 'rosemary']) {
      const [link] = anchorsTo(root, `/care/${slug}`);
      expect(link, slug).toBeDefined();
      expect(link?.textContent?.trim().toLowerCase()).toBe(
        findCareGuide(slug)?.commonName.toLowerCase()
      );
    }
  });

  it('the Spanish home page labels them with catalog names, not keys', async () => {
    await i18n.changeLanguage('es');
    const root = landing();
    expect(anchorsTo(root, '/care/rosemary')[0]?.textContent?.trim()).toBe('Romero');
    expect(anchorsTo(root, '/care/haworthia')[0]?.textContent?.trim()).toBe('Haworthia');
  });

  it('the overwatering post names each one in its plant list, as a link', () => {
    const post = findPost(CANONICAL.slice('/blog/'.length));
    expect(post).toBeDefined();
    const Body = post!.Component;
    const html = renderToStaticMarkup(<Body />);
    for (const slug of ['haworthia', 'blue-echeveria', 'sago-palm', 'rosemary']) {
      expect(findCareGuide(slug), slug).toBeDefined();
      expect(html, slug).toContain(`href="/care/${slug}"`);
    }
    // The list reads as a list: a space after every comma between links.
    const text = html.replace(/<[^>]+>/g, '');
    expect(text).toContain(
      'snake plant, ZZ plant, aloe vera, jade plant, haworthia, blue echeveria'
    );
    expect(text).not.toMatch(/,[A-Za-z]/);
  });
});

describe('the yellow-leaves posts are merged into the overwatering post', () => {
  it('publishes only the overwatering post', () => {
    for (const slug of MERGED) expect(findPost(slug), slug).toBeUndefined();
    expect(findPost(CANONICAL.slice('/blog/'.length))).toBeDefined();
  });

  it('redirects both old URLs to it', () => {
    const map = REDIRECTS as Record<string, string>;
    for (const slug of MERGED) expect(map[`/blog/${slug}`], slug).toBe(CANONICAL);
  });

  it('leaves no post linking to an old URL', () => {
    const moved = Object.keys(REDIRECTS);
    for (const post of POSTS) {
      const Body = post.Component;
      const html = renderToStaticMarkup(<Body />);
      for (const from of moved) expect(html, `${post.slug} -> ${from}`).not.toContain(from);
    }
  });

  it('drops the old URLs from the committed sitemap', () => {
    const sitemap = readFileSync(join(process.cwd(), 'public', 'sitemap.xml'), 'utf8');
    for (const slug of MERGED) expect(sitemap).not.toContain(`/blog/${slug}<`);
    expect(sitemap).toContain(`<loc>https://familygreenhouse.net${CANONICAL}</loc>`);
  });

  it.each(MERGED)('sends an in-app visit to /blog/%s to the merged post', async (slug) => {
    render(
      <MemoryRouter initialEntries={[`/blog/${slug}`]}>
        <Routes>
          <Route path="/blog/:slug" element={<BlogPost />} />
          <Route path="/blog" element={<p>blog index</p>} />
        </Routes>
      </MemoryRouter>
    );
    const title = findPost(CANONICAL.slice('/blog/'.length))!.title;
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.queryByText('blog index')).toBeNull();
  });

  it('negative control: an unknown slug still goes to the blog index', async () => {
    render(
      <MemoryRouter initialEntries={['/blog/no-such-post']}>
        <Routes>
          <Route path="/blog/:slug" element={<BlogPost />} />
          <Route path="/blog" element={<p>blog index</p>} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('blog index')).toBeInTheDocument();
  });
});
