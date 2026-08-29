import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Runs the CloudFront viewer-request function verbatim from the file Terraform
 * ships. It sits in front of EVERY request to the site, and a mistake in it is
 * a total outage, so its behavior is pinned here rather than discovered on a
 * production apply. The file is plain ES 5.1, which is what
 * `cloudfront-js-2.0` guarantees.
 */
const source = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../infrastructure/modules/frontend/functions/rewrite-uri.js'
  ),
  'utf8'
);
const handler = new Function(`${source}; return handler;`)() as (event: {
  request: { uri: string };
}) => { uri: string };

const rewrite = (uri: string) => handler({ request: { uri } }).uri;

describe('CloudFront URI rewrite', () => {
  it('resolves the prerendered page for an extensionless route', () => {
    expect(rewrite('/care/pothos')).toBe('/care/pothos/index.html');
    expect(rewrite('/pricing')).toBe('/pricing/index.html');
    expect(rewrite('/legal/privacy')).toBe('/legal/privacy/index.html');
  });

  it('resolves directory-style URLs, including the site root', () => {
    expect(rewrite('/')).toBe('/index.html');
    expect(rewrite('/care/')).toBe('/care/index.html');
  });

  it('leaves anything with a file extension alone', () => {
    expect(rewrite('/assets/index-a1b2c3.js')).toBe('/assets/index-a1b2c3.js');
    expect(rewrite('/brand/og-image.png')).toBe('/brand/og-image.png');
    expect(rewrite('/robots.txt')).toBe('/robots.txt');
    expect(rewrite('/sitemap.xml')).toBe('/sitemap.xml');
    expect(rewrite('/manifest.webmanifest')).toBe('/manifest.webmanifest');
    expect(rewrite('/sw.js')).toBe('/sw.js');
  });

  it('sends a route with no prerendered page to a key that misses, as before', () => {
    // /dashboard has no file; S3 404s and the distribution's SPA fallback
    // answers, exactly as it does today. The rewrite must not change that.
    expect(rewrite('/dashboard')).toBe('/dashboard/index.html');
    expect(rewrite('/this-page-does-not-exist')).toBe('/this-page-does-not-exist/index.html');
  });
});
