/**
 * A `/pet-safe/<slug>` page's sitemap `<lastmod>` comes from its content,
 * never from the clock.
 *
 * `sitemap:check` byte-compares the committed sitemap with the generator's
 * output, which proves the file is fresh and cannot prove a date is RIGHT:
 * both sides read the same source (the #722 lesson, for /changelog). So the
 * assertions live here, outside the generator:
 *
 *   - the committed sitemap's plant dates are the ledger's, and the ledger's
 *     digests are the table's current content;
 *   - moving the system clock changes no plant date, in the route list or in
 *     the re-dating script;
 *   - changing one entry's content un-dates exactly that page (the sitemap
 *     then refuses to build) until it is re-dated, and re-dating moves only
 *     that page's date.
 *
 * The page count is checked against the TypeScript table imported directly,
 * not through the scripts' transpiling loader, so a loader that silently read
 * fewer entries could not agree with itself into a pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PET_TOXICITY } from '../../../../backend/src/models/petToxicity';
import {
  plantPageRoutes,
  publicRoutes,
  readPlantPagesLedger,
  // @ts-expect-error - vanilla ESM build script, deliberately untyped
} from '../../../scripts/public-routes.mjs';
import {
  loadPetToxicityTable,
  pageContentDigest,
  publishedPlantPages,
  // @ts-expect-error - vanilla ESM build script, deliberately untyped
} from '../../../scripts/pet-toxicity-table.mjs';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import { nextLedger } from '../../../scripts/build-plant-pages-lastmod.mjs';

interface Route {
  path: string;
  lastmod?: string;
  unverifiedLastmod?: string;
}
interface Ledger {
  pages: Record<string, { content: string; lastmod: string }>;
}

const SITEMAP = resolve(__dirname, '../../../public/sitemap.xml');

/** `{ path: lastmod }` for every /pet-safe/<slug> <url> in the committed sitemap. */
function sitemapPlantDates(): Map<string, string | undefined> {
  const xml = readFileSync(SITEMAP, 'utf8');
  const out = new Map<string, string | undefined>();
  for (const block of xml.split('<url>').slice(1)) {
    const loc = /<loc>https:\/\/[^/]+(\/pet-safe\/[^<]+)<\/loc>/.exec(block)?.[1];
    if (loc) out.set(loc, /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1]);
  }
  return out;
}

const plantRoutes = (routes: Route[]) => routes.filter((r) => r.path.startsWith('/pet-safe/'));

afterEach(() => {
  vi.useRealTimers();
});

describe('/pet-safe/<slug> sitemap lastmod', () => {
  it('the committed sitemap dates every plant page from the ledger, and the ledger matches the table', () => {
    const ledger: Ledger = readPlantPagesLedger();
    const dates = sitemapPlantDates();
    const listed = PET_TOXICITY.filter((e) => e.aspcaListing !== undefined);

    expect(dates.size).toBe(listed.length);
    for (const entry of listed) {
      const recorded = ledger.pages[entry.slug];
      expect(recorded, `${entry.slug} missing from the ledger`).toBeDefined();
      expect(dates.get(`/pet-safe/${entry.slug}`), entry.slug).toBe(recorded!.lastmod);
      expect(recorded!.content, `${entry.slug} digest`).toBe(pageContentDigest(entry));
    }
  });

  it('moving the clock moves no plant date', () => {
    const ledger: Ledger = readPlantPagesLedger();
    const atRealTime = plantRoutes(publicRoutes());

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-07-04T12:00:00Z'));

    const later = plantRoutes(publicRoutes());
    expect(later).toEqual(atRealTime);
    for (const route of later) {
      expect(route.unverifiedLastmod, route.path).toBeUndefined();
      expect(route.lastmod, route.path).not.toBe('2031-07-04');
    }
    expect(nextLedger(ledger, publishedPlantPages(), '2031-07-04').pages).toEqual(ledger.pages);
  });

  it('a content change un-dates exactly that page, and re-dating moves exactly that date', () => {
    const ledger: Ledger = readPlantPagesLedger();
    const table = loadPetToxicityTable();
    const changed = {
      ...table,
      entries: table.entries.map((e: { slug: string; note: string }) =>
        e.slug === 'hoya' ? { ...e, note: `${e.note} One more sentence.` } : e
      ),
    };

    const routes: Route[] = plantPageRoutes(changed, ledger);
    const hoya = routes.find((r) => r.path === '/pet-safe/hoya')!;
    expect(hoya.lastmod).toBeUndefined();
    expect(hoya.unverifiedLastmod).toMatch(/changed after \d{4}-\d{2}-\d{2}/);
    for (const route of routes.filter((r) => r !== hoya)) {
      expect(route.lastmod, route.path).toBe(
        ledger.pages[route.path.slice('/pet-safe/'.length)]!.lastmod
      );
    }

    const next: Ledger = nextLedger(ledger, publishedPlantPages(changed), '2031-07-04');
    expect(next.pages.hoya!.lastmod).toBe('2031-07-04');
    for (const [slug, value] of Object.entries(next.pages)) {
      if (slug !== 'hoya') expect(value).toEqual(ledger.pages[slug]);
    }
  });

  it('the digest follows what the page shows, not what it hides', () => {
    const hoya = PET_TOXICITY.find((e) => e.slug === 'hoya')!;
    const digest = pageContentDigest(hoya);
    expect(pageContentDigest({ ...hoya, aliases: ['something else'] })).toBe(digest);
    expect(pageContentDigest({ ...hoya, dogs: 'toxic' })).not.toBe(digest);
    expect(pageContentDigest({ ...hoya, note: `${hoya.note}.` })).not.toBe(digest);
    expect(
      pageContentDigest({
        ...hoya,
        aspcaListing: { ...hoya.aspcaListing!, path: '/toxic-and-non-toxic-plants/other' },
      })
    ).not.toBe(digest);
  });
});
