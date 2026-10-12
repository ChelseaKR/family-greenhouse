import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTS } from '@/features/blog/posts';
import { PLANT_SAFETY_PAGES } from '@/features/petsafe/plantSafetyPages';

/**
 * The two pet-safety posts link the /pet-safe/<plant> page of every plant
 * they name that has one. Measured before this test existed: they linked 10
 * and 11 care guides and zero plant safety pages, though those pages answer
 * the question both posts are about. Names come from the table's own
 * `commonName` (minus any parenthetical), so a page published later is
 * covered the day it lands.
 */
const PET_POSTS = [
  'pet-safe-houseplants-that-are-hard-to-kill',
  'most-common-toxic-houseplants-and-safer-swaps',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const rendered = POSTS.map((post) => {
  const Component = post.Component;
  const html = renderToStaticMarkup(<Component />);
  return { slug: post.slug, html, text: text(html) };
});

describe('blog posts link the plant safety pages', () => {
  it('finds both pet-safety posts', () => {
    expect(
      rendered
        .filter((r) => PET_POSTS.includes(r.slug))
        .map((r) => r.slug)
        .sort()
    ).toEqual([...PET_POSTS].sort());
  });

  it('the pet-safety posts link each named plant that has a page', () => {
    const missing: string[] = [];
    for (const r of rendered.filter((post) => PET_POSTS.includes(post.slug))) {
      for (const page of PLANT_SAFETY_PAGES) {
        const name = page.commonName.replace(/\s*\(.*\)\s*$/, '');
        if (!new RegExp(`\\b${esc(name)}\\b`, 'i').test(r.text)) continue;
        if (!r.html.includes(`href="/pet-safe/${page.slug}"`))
          missing.push(`${r.slug} names ${name} and never links /pet-safe/${page.slug}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('every post links only published plant safety pages', () => {
    const slugs = new Set(PLANT_SAFETY_PAGES.map((page) => page.slug));
    let links = 0;
    for (const r of rendered) {
      for (const m of r.html.matchAll(/href="\/pet-safe\/([^"#?]+)"/g)) {
        links += 1;
        expect(slugs.has(m[1]!), `${r.slug} links /pet-safe/${m[1]}, which is not published`).toBe(
          true
        );
      }
    }
    // 23 links when this landed; zero would mean the matching broke, not the content.
    expect(links).toBeGreaterThanOrEqual(20);
  });
});
