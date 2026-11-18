import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { BlogPost } from '@/features/blog/BlogPost';
import { POSTS } from '@/features/blog/posts';

/**
 * A blog post's modified date, as its page publishes it.
 *
 * Until 2026-11-17 every post published its publish date as `dateModified`
 * and no `article:modified_time` at all, although all 14 had been edited
 * since. The page now reads the manifest's `updated` field, the same field
 * the sitemap's `<lastmod>` comes from (scripts/blog-posts-lastmod.test.mjs
 * holds the sitemap to it).
 */

type Node = Record<string, unknown>;

function renderPost(slug: string) {
  render(
    <MemoryRouter initialEntries={[`/blog/${slug}`]}>
      <Routes>
        <Route path="/blog/:slug" element={<BlogPost />} />
      </Routes>
    </MemoryRouter>
  );
  const script = document.querySelector('script[type="application/ld+json"][data-use-meta-tags]');
  expect(script).not.toBeNull();
  const graph = JSON.parse(script!.textContent!)['@graph'] as Node[];
  return {
    article: graph.find((n) => n['@type'] === 'Article')!,
    meta: (property: string) =>
      document.querySelector(`meta[property="${property}"]`)?.getAttribute('content') ?? null,
  };
}

describe('blog post modified date', () => {
  it.each(POSTS.filter((p) => p.updated).map((p) => [p.slug, p.date, p.updated!] as const))(
    '%s publishes its publish date and its later modified date',
    (slug, date, updated) => {
      const { article, meta } = renderPost(slug);
      expect(article.datePublished).toBe(date);
      expect(article.dateModified).toBe(updated);
      expect(meta('article:published_time')).toBe(date);
      expect(meta('article:modified_time')).toBe(updated);
      expect(updated >= date).toBe(true);
    }
  );

  it('dates the overwatering post to the day its merge went live, not to 2026-07-29', () => {
    const { article } = renderPost('signs-of-overwatering-and-how-to-fix-it');
    expect(article.datePublished).toBe('2026-07-29');
    expect((article.dateModified as string) >= '2026-11-17').toBe(true);
  });

  it('gives an unedited post one date and no modified time', () => {
    // Negative control: without `updated`, the page must not invent a second
    // date. No real post is unedited today, so one is made for the test.
    const original = POSTS[0]!;
    POSTS[0] = { ...original, updated: undefined };
    try {
      const { article, meta } = renderPost(original.slug);
      expect(article.dateModified).toBe(original.date);
      expect(meta('article:modified_time')).toBeNull();
    } finally {
      POSTS[0] = original;
    }
  });
});
