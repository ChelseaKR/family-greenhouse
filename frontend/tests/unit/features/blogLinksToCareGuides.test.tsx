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
        if (!r.html.includes(`href="/care/${g.slug}"`))
          missing.push(`${r.slug} names ${g.commonName} and never links /care/${g.slug}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
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
