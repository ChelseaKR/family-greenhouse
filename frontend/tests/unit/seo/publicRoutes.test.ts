import { describe, expect, it } from 'vitest';
import { STATIC_PUBLIC_ROUTES, canonicalUrl, publicRoute } from '@/config/publicRoutes';
import { HERO_HEADLINES, headlineText } from '@/features/landing/heroHeadlines';
import { SITE_URL } from '@/config/site';

/**
 * The manifest feeds three consumers that cannot check each other at runtime:
 * the React pages, the prerenderer, and the sitemap generator. These are the
 * invariants all three assume. `scripts/check-seo-build.mjs` re-checks the same
 * shape against the built output; this catches a bad entry before a build.
 */
describe('public route manifest', () => {
  it('gives every route a unique path, title and description', () => {
    const paths = STATIC_PUBLIC_ROUTES.map((r) => r.path);
    const titles = STATIC_PUBLIC_ROUTES.map((r) => r.title);
    const descriptions = STATIC_PUBLIC_ROUTES.map((r) => r.description);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('keeps titles and descriptions inside the length the build gate enforces', () => {
    for (const route of STATIC_PUBLIC_ROUTES) {
      expect(route.title.length, `${route.path} title`).toBeGreaterThanOrEqual(20);
      expect(route.title.length, `${route.path} title`).toBeLessThanOrEqual(75);
      expect(route.description.length, `${route.path} description`).toBeGreaterThanOrEqual(70);
      expect(route.description.length, `${route.path} description`).toBeLessThanOrEqual(165);
      expect(route.heading.trim(), `${route.path} heading`).not.toBe('');
      expect(route.sources.length, `${route.path} sources`).toBeGreaterThan(0);
    }
  });

  it('builds absolute, apex-hosted canonicals', () => {
    expect(canonicalUrl('/')).toBe('https://familygreenhouse.net/');
    expect(canonicalUrl('/care')).toBe('https://familygreenhouse.net/care');
    for (const route of STATIC_PUBLIC_ROUTES) {
      const canonical = canonicalUrl(route.path);
      expect(canonical.startsWith('https://familygreenhouse.net')).toBe(true);
      // Never www: apex and www serve identical bytes, so the canonical is the
      // only in-repo signal that says which one is the real URL.
      expect(canonical).not.toContain('www.');
      expect(canonical.startsWith(SITE_URL)).toBe(true);
    }
  });

  it('serves the control hero headline as the homepage h1, from the hero itself', () => {
    expect(publicRoute('/').heading).toBe(headlineText(HERO_HEADLINES.A));
  });

  it('refuses to invent a head for an unregistered route', () => {
    // Returning a partial head would let a route silently fall back to the
    // shell's homepage title, which is the defect the manifest exists to end.
    expect(() => publicRoute('/not-a-route')).toThrow(/No public route registered/);
  });
});
