import { describe, it, expect } from 'vitest';
import {
  DEFAULT_META,
  DEFAULT_OG_IMAGE,
  headToTags,
  jsonLdScript,
  organizationNode,
  resolveHead,
  withOrganization,
} from '@/config/seo';

/**
 * `config/seo.ts` is the module that turns a route's `useMetaTags` payload into
 * the literal HTML a crawler reads. It runs at build time inside
 * scripts/prerender.mjs, so nothing in the app's runtime tests would catch a
 * regression here — a broken canonical would just quietly ship.
 */
describe('resolveHead', () => {
  it('canonicalizes a route to its own URL when it does not set one', () => {
    const head = resolveHead({ title: 'Care guides' }, '/care');
    expect(head.canonical).toBe('https://familygreenhouse.net/care');
  });

  it('prefers an explicit canonical over the rendered path', () => {
    const head = resolveHead(
      { canonical: 'https://familygreenhouse.net/care/pothos' },
      '/care/pothos/'
    );
    expect(head.canonical).toBe('https://familygreenhouse.net/care/pothos');
  });

  it('emits NO canonical for the SPA shell, which answers for arbitrary URLs', () => {
    const head = resolveHead(null, null);
    expect(head.canonical).toBeNull();
    expect(headToTags(head)).not.toContain('rel="canonical"');
    expect(headToTags(head)).not.toContain('og:url');
  });

  it('falls back to the homepage defaults when a route sets nothing', () => {
    const head = resolveHead(null, null);
    expect(head.title).toBe(DEFAULT_META.title);
    expect(head.description).toBe(DEFAULT_META.description);
    expect(head.ogImage).toBe(DEFAULT_OG_IMAGE);
  });

  it('marks the SPA shell noindex, because it answers for arbitrary URLs', () => {
    // dist/app-shell.html is CloudFront's 403/404 response, so it is what a
    // crawler receives for /dashboard, /typo, and every token-scoped URL
    // (/sit/<token>, /tag/<token>, /kiosk/<token>, /shared/<code>). ADR 0013
    // decided it carries a noindex; this pins that decision to the code.
    expect(resolveHead(null, null).robots).toBe('noindex, follow');
    expect(headToTags(resolveHead(null, null))).toContain(
      '<meta name="robots" content="noindex, follow" />'
    );
  });

  it('keeps a rendered route indexable', () => {
    expect(resolveHead(null, '/pricing').robots).toBe('index, follow');
    expect(resolveHead({ title: 'Pothos Care' }, '/care/pothos').robots).toBe('index, follow');
  });

  it('lets a route override the shell default in either direction', () => {
    expect(resolveHead({ robots: 'noindex, nofollow' }, '/tag/abc').robots).toBe(
      'noindex, nofollow'
    );
    expect(resolveHead({ robots: 'index, follow' }, null).robots).toBe('index, follow');
  });

  it('mirrors a route title into the social cards, as the client hook does', () => {
    const head = resolveHead(
      { title: 'Pothos Care', description: 'Watering a pothos.' },
      '/care/pothos'
    );
    expect(head.ogTitle).toBe('Pothos Care');
    expect(head.twitterTitle).toBe('Pothos Care');
    expect(head.ogDescription).toBe('Watering a pothos.');
    expect(head.twitterDescription).toBe('Watering a pothos.');
  });
});

/**
 * Organization JSON-LD, site-wide.
 *
 * Before this, Organization existed only on the four routes that hand-wrote
 * it (LandingPage, pricingJsonLd, and the Article `publisher` on care guides
 * and blog posts) and was absent from every other public page — /blog,
 * /care, /help and its topics, /gift, /changelog, /pet-safe, both legal
 * pages. Putting the merge in `resolveHead` is what makes it "in the page
 * shell" rather than a per-page opt-in.
 */
describe('withOrganization', () => {
  it('publishes real, checkable values — not invented ones', () => {
    const org = organizationNode();
    expect(org.name).toBe('Family Greenhouse');
    expect(org.url).toBe('https://familygreenhouse.net');
    // The real asset already shipped at frontend/public/brand/icon-512.png —
    // the same file LandingPage's and pricingJsonLd's own Organization nodes
    // point at.
    expect(org.logo).toBe('https://familygreenhouse.net/brand/icon-512.png');
    expect(org['@id']).toBe('https://familygreenhouse.net/#organization');
    // No sameAs: the footer's only outbound link is to Perenual, not a real
    // social profile of Family Greenhouse's own.
    expect(org.sameAs).toBeUndefined();
  });

  it('adds the node to a route that publishes no JSON-LD at all', () => {
    const merged = withOrganization(undefined, true);
    expect(merged?.['@graph']).toEqual([organizationNode()]);
  });

  it('adds the node onto a route that already has other JSON-LD', () => {
    const faq = { '@type': 'FAQPage', mainEntity: [] };
    const merged = withOrganization({ '@context': 'https://schema.org', '@graph': [faq] }, true);
    expect(merged?.['@graph']).toEqual([faq, organizationNode()]);
  });

  it('does not add a second copy when the route already names this @id', () => {
    const own = { ...organizationNode(), description: 'a route-specific description' };
    const original = { '@context': 'https://schema.org', '@graph': [own] };
    expect(withOrganization(original, true)).toBe(original);
  });

  it('skips a non-indexable page entirely, JSON-LD absent or present', () => {
    expect(withOrganization(undefined, false)).toBeUndefined();
    const faq = { '@context': 'https://schema.org', '@graph': [{ '@type': 'FAQPage' }] };
    expect(withOrganization(faq, false)).toBe(faq);
  });

  it('is what resolveHead publishes for an indexable route with no JSON-LD', () => {
    // /changelog, /legal/privacy, /legal/terms, /support and /status all call
    // useMetaTags with only a title and description — this is what makes
    // Organization reach them without anyone touching those five files.
    const head = resolveHead({ title: 'Changelog — Family Greenhouse' }, '/changelog');
    expect(head.jsonLd).toEqual({
      '@context': 'https://schema.org',
      '@graph': [organizationNode()],
    });
    const tags = headToTags(head);
    expect(tags).toContain('"@type":"Organization"');
  });

  it('is absent from the noindex SPA shell', () => {
    expect(resolveHead(null, null).jsonLd).toBeUndefined();
  });

  it('still adds a standalone node when the only existing reference is nested', () => {
    // CareGuidePage and BlogPost name this @id, but only inside the
    // Article's `publisher` field, never as a standalone top-level graph
    // node — so a crawler reading either page in isolation has no
    // independently resolvable Organization to find. The merge only skips
    // routes that already name the @id at the TOP LEVEL of `@graph` (the
    // dedupe case above); a nested reference like this one still gets the
    // standalone node added alongside it, same as pricingJsonLd.ts already
    // does by hand for its own SoftwareApplication.publisher reference.
    const article = {
      '@type': 'Article',
      headline: 'Pothos care',
      publisher: { '@type': 'Organization', '@id': `${organizationNode()['@id']}`, name: 'x' },
    };
    const merged = withOrganization(
      { '@context': 'https://schema.org', '@graph': [article] },
      true
    );
    const graph = merged?.['@graph'] as Record<string, unknown>[];
    expect(graph).toHaveLength(2);
    expect(graph[1]).toEqual(organizationNode());
  });
});

describe('headToTags', () => {
  it('escapes attribute values so copy with quotes or angle brackets is safe', () => {
    const tags = headToTags(
      resolveHead({ title: 'A "bold" <claim> & more', description: 'x' }, '/blog/x')
    );
    expect(tags).toContain('<title>A &quot;bold&quot; &lt;claim&gt; &amp; more</title>');
    expect(tags).toContain('content="A &quot;bold&quot; &lt;claim&gt; &amp; more"');
  });

  it('never emits an href-less canonical', () => {
    // The defect this replaced: a <link rel="canonical"> with no href reads as
    // "this page canonicalizes to nothing". Either a real absolute URL, or the
    // tag is absent.
    for (const head of [resolveHead(null, null), resolveHead({ title: 't' }, '/pricing')]) {
      const tags = headToTags(head);
      expect(tags).not.toMatch(/<link rel="canonical"\s*\/?>/);
      expect(tags).not.toContain('href=""');
    }
  });

  it('emits an absolute og:image — social scrapers reject a relative one', () => {
    const tags = headToTags(resolveHead({ title: 't' }, '/'));
    expect(tags).toContain('content="https://familygreenhouse.net/brand/og-image.png"');
  });

  it('inlines JSON-LD with < escaped so data cannot break out of the script tag', () => {
    const payload = { '@type': 'Article', name: '</script><script>alert(1)</script>' };
    expect(jsonLdScript(payload)).not.toContain('</script>');
    const tags = headToTags(resolveHead({ jsonLd: payload }, '/blog/x'));
    expect(tags).toContain('application/ld+json');
    expect(tags.split('<script type="application/ld+json">')[1]).not.toContain('</script><script>');
  });
});

/**
 * `article:*` and `og:locale`. Both content templates declared
 * `og:type=article` while shipping none of the properties that type carries,
 * so a LinkedIn or Facebook unfurl of a post or a care guide had no date to
 * show — and evergreen guides had no freshness signal at all in a preview.
 */
describe('article Open Graph properties', () => {
  it('emits og:locale on every page, article or not', () => {
    const tags = headToTags(resolveHead({ title: 'x' }, '/x'));
    expect(tags).toContain('<meta property="og:locale" content="en_US" />');
  });

  it('emits only the article dates a route actually supplies', () => {
    const post = headToTags(
      resolveHead(
        {
          title: 'p',
          ogType: 'article',
          article: { publishedTime: '2026-05-05', section: 'Blog' },
        },
        '/blog/p'
      )
    );
    expect(post).toContain('<meta property="article:published_time" content="2026-05-05" />');
    expect(post).toContain('<meta property="article:section" content="Blog" />');
    // A blog post has no modified date to give: the manifest has no such
    // field, and restating publishedTime as modifiedTime is the conflation
    // the Article JSON-LD already makes.
    expect(post).not.toContain('article:modified_time');
  });

  it('lets a care guide give a review date without claiming a publish date', () => {
    const guide = headToTags(
      resolveHead(
        {
          title: 'g',
          ogType: 'article',
          article: { modifiedTime: '2026-09-02', section: 'Plant care' },
        },
        '/care/g'
      )
    );
    expect(guide).toContain('<meta property="article:modified_time" content="2026-09-02" />');
    expect(guide).not.toContain('article:published_time');
  });

  it('never emits article:* on a non-article page', () => {
    const page = headToTags(
      resolveHead({ title: 'x', article: { publishedTime: '2026-05-05' } }, '/pricing')
    );
    expect(page).not.toContain('article:');
  });
});
