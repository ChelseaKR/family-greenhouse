/**
 * Which navigations the service worker answers with the SPA shell.
 *
 * With the worker installed, https://familygreenhouse.net/sitemap.xml rendered
 * the app's 404 page: workbox's `navigateFallback` answered it with
 * app-shell.html, because the denylist named only `/api/`. The server was
 * serving the real file the whole time. vite.navigationFallback.ts now sends
 * files and `/.well-known/` to the network; this pins both halves of that —
 * files are denied, and no real route is.
 *
 * Every route shape here comes from the code rather than from memory: the
 * router's paths are read out of App.tsx, the public pages out of the
 * committed sitemap, and the token shapes are pinned to the generators that
 * mint them, so a token format that could contain a dot fails this test
 * instead of silently losing its route's offline fallback.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The `.ts` extension is load-bearing, for the reason nonEnglishCatalog.test.ts
// gives: an extensionless import resolves to the `.js` that `tsc -b` emits
// beside the source, which is the LAST BUILD's array, not this one.
import { NAVIGATE_FALLBACK_DENYLIST } from '../../../vite.navigationFallback.ts';

const FRONTEND = process.cwd();
const REPO = resolve(FRONTEND, '..');

/** What workbox tests: `url.pathname + url.search` (NavigationRoute._match). */
function sentToNetwork(pathAndSearch: string): boolean {
  return NAVIGATE_FALLBACK_DENYLIST.some((pattern) => pattern.test(pathAndSearch));
}

const hex64 = () => randomBytes(32).toString('hex');
const compactUuid = () => randomUUID().replace(/-/g, '');

/**
 * A real value for every route parameter the router declares. A parameter not
 * listed here fails the router test below: someone has to decide whether its
 * values can contain a dot before it ships.
 */
const PARAM_VALUES: Record<string, () => string> = {
  token: hex64, // sitter, kiosk, tag and caretaker links
  inviteCode: compactUuid,
  code: compactUuid, // plant share card
  plantId: randomUUID,
  slug: () => 'heartleaf-philodendron',
  topicId: () => 'getting-started',
};

describe('the service worker navigation fallback', () => {
  it('sends files and well-known URIs to the network', () => {
    for (const path of [
      '/sitemap.xml',
      '/robots.txt',
      `/${'ab'.repeat(16)}.txt`, // the IndexNow key file's shape
      '/.well-known/assetlinks.json',
      '/.well-known/apple-app-site-association',
      '/brand/icon.svg',
      '/sitemap.xml?utm_source=newsletter',
      '/api/health',
    ]) {
      expect(sentToNetwork(path), path).toBe(true);
    }
  });

  it('keeps the shell for routes, including ones whose query has a dot', () => {
    const uuid = randomUUID();
    for (const path of [
      '/',
      '/dashboard',
      '/pricing',
      `/plants/${uuid}`,
      `/plants/${uuid}?task=${randomUUID()}`,
      `/sit/${hex64()}`,
      `/sit/${hex64()}/brief`,
      `/kiosk/${hex64()}`,
      `/tag/${hex64()}`,
      `/caretaker/${hex64()}`,
      `/join/${compactUuid()}`,
      `/shared/${compactUuid()}`,
      '/care/monstera',
      '/care/monstera/',
      '/confirm-email?email=someone@example.com',
      '/reset-password?email=first.last@example.co.uk&code=123456',
      '/settings/billing?session_id=cs_live_a1.b2',
    ]) {
      expect(sentToNetwork(path), path).toBe(false);
    }
  });

  it('keeps the shell for every path the router declares', () => {
    const app = readFileSync(resolve(FRONTEND, 'src/App.tsx'), 'utf8');
    const paths = [...app.matchAll(/\bpath="([^"]+)"/g)].map((match) => match[1]);
    // Guard: a pattern that stopped matching would pass the loop vacuously.
    expect(paths.length).toBeGreaterThan(30);

    for (const path of paths.filter((p) => p !== '*')) {
      const concrete = path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
        const value = PARAM_VALUES[name];
        if (!value) {
          throw new Error(
            `${path}: new route parameter :${name}. Add it to PARAM_VALUES with the shape its ` +
              'generator really produces, and if that shape can contain a dot, exclude the ' +
              'route prefix in vite.navigationFallback.ts rather than lose its fallback.'
          );
        }
        return value();
      });
      expect(sentToNetwork(concrete), `${path} -> ${concrete}`).toBe(false);
    }
  });

  it('keeps the shell for every public page in the sitemap', () => {
    const sitemap = readFileSync(resolve(FRONTEND, 'public/sitemap.xml'), 'utf8');
    const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => new URL(match[1]).pathname
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(sentToNetwork(path), path).toBe(false);
  });

  it('matches the token shapes the generators actually mint', () => {
    // If one of these changes, the PARAM_VALUES shape above is no longer the
    // real one, and the router test proves nothing about that route.
    for (const service of [
      'sitterService',
      'kioskService',
      'plantTagService',
      'caretakerService',
    ]) {
      const source = readFileSync(resolve(REPO, `backend/src/services/${service}.ts`), 'utf8');
      expect(source, `${service} token shape`).toContain(
        "const token = randomBytes(32).toString('hex');"
      );
    }
    for (const service of ['householdService', 'plantService']) {
      const source = readFileSync(resolve(REPO, `backend/src/services/${service}.ts`), 'utf8');
      expect(source, `${service} code shape`).toContain("const code = uuid().replace(/-/g, '');");
    }
  });

  it('has no stateful flags, which would make alternate navigations disagree', () => {
    for (const pattern of NAVIGATE_FALLBACK_DENYLIST) {
      expect(pattern.flags, String(pattern)).not.toMatch(/[gy]/);
    }
  });

  it('is the list vite.config.ts hands to workbox', () => {
    const config = readFileSync(resolve(FRONTEND, 'vite.config.ts'), 'utf8');
    expect(config).toContain("from './vite.navigationFallback'");
    expect(config).toMatch(/navigateFallbackDenylist:\s*NAVIGATE_FALLBACK_DENYLIST\b/);
    expect(config).toContain("navigateFallback: 'app-shell.html'");
  });
});
