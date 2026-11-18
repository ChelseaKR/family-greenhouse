import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTS } from '@/features/blog/posts';
import { CARE_GUIDES } from '@/features/care/careGuides';

/**
 * A blog post that names a plant we have a care guide for links to that
 * guide. Measured before this test existed: the fourteen posts named the
 * guides' plants fifty times between them and linked to a guide zero times,
 * so each guide's only inbound links were the /care index and three rotated
 * siblings — from a site whose own articles kept naming them.
 *
 * Names are the registry's own (`commonName` + `alsoKnownAs`), so a guide
 * added later is covered the day it lands, and a post that starts naming
 * one fails here until it links.
 */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Links held back on purpose, as "post -> guide". Existing pages keep their
 * bodies unchanged until the 12-01 title read (fg-next-guides-plan-2026-11-05),
 * so a post that names a guide added in that window links it after the read.
 * Each entry must still be missing: once the link lands, delete the entry.
 */
const HELD_UNTIL_TITLE_READ = new Set(['pet-safe-houseplants-that-are-hard-to-kill -> areca-palm']);

function renderedText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('blog posts link the care guides they name', () => {
  const rendered = POSTS.map((post) => {
    const Component = post.Component;
    const html = renderToStaticMarkup(<Component />);
    return { slug: post.slug, html, text: renderedText(html) };
  });

  it('renders every post', () => {
    expect(rendered.length).toBeGreaterThanOrEqual(14);
    for (const r of rendered) expect(r.text.length, r.slug).toBeGreaterThan(500);
  });

  it('links each named guide at least once', () => {
    const missing: string[] = [];
    for (const r of rendered) {
      for (const g of CARE_GUIDES) {
        const names = new RegExp(
          `\\b(${[g.commonName, ...g.alsoKnownAs].map(esc).join('|')})\\b`,
          'i'
        );
        if (!names.test(r.text)) continue;
        if (r.html.includes(`href="/care/${g.slug}"`)) continue;
        if (HELD_UNTIL_TITLE_READ.has(`${r.slug} -> ${g.slug}`)) continue;
        missing.push(`${r.slug} names ${g.commonName} and never links /care/${g.slug}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('holds back only links that are really missing', () => {
    for (const held of HELD_UNTIL_TITLE_READ) {
      const [post, slug] = held.split(' -> ');
      const r = rendered.find((x) => x.slug === post);
      expect(r, held).toBeDefined();
      const g = CARE_GUIDES.find((x) => x.slug === slug);
      expect(g, held).toBeDefined();
      // The post does name the plant, so the exemption is doing real work...
      expect(r!.text.toLowerCase(), held).toContain(g!.commonName.toLowerCase());
      // ...and has not linked it yet; when it does, remove the entry.
      expect(r!.html.includes(`href="/care/${slug}"`), held).toBe(false);
    }
  });

  it('links only guides that exist', () => {
    const slugs = new Set(CARE_GUIDES.map((g) => g.slug));
    for (const r of rendered) {
      for (const m of r.html.matchAll(/href="\/care\/([^"#?]+)"/g)) {
        expect(slugs.has(m[1]!), `${r.slug} links /care/${m[1]}, which is not a guide`).toBe(true);
      }
    }
  });

  it('covers a meaningful share of the posts', () => {
    // 12 of 14 posts named at least one guide plant when this landed. If this
    // ever reads zero, the name matching broke, not the content.
    const linking = rendered.filter((r) => /href="\/care\//.test(r.html)).length;
    expect(linking).toBeGreaterThanOrEqual(12);
  });
});
