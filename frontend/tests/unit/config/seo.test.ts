import { describe, it, expect } from 'vitest';
import {
  DEFAULT_META,
  DEFAULT_OG_IMAGE,
  headToTags,
  jsonLdScript,
  resolveHead,
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
    expect(head.robots).toBe('index, follow');
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
