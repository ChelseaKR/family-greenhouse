/**
 * `dateModified` on every `/pet-safe/<slug>` page is that page's sitemap
 * `<lastmod>`, and nothing else.
 *
 * The sitemap already told crawlers when each plant page last changed (the
 * ledger date, pinned to a digest of what the page shows). The page's own
 * structured data said nothing, so the two could not be compared. Now they
 * are the same date, read here from the committed `public/sitemap.xml` rather
 * than from the ledger the page reads, and the build gate fails a page whose
 * date is missing, different, or present when the sitemap has none.
 *
 * Each negative control applies a sabotage, asserts the sabotage changed the
 * input, and then asserts the gate names the fault.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import i18next from 'i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ASPCA_ANIMAL_POISON_CONTROL_URL,
  PET_TOXICITY,
} from '../../../../backend/src/models/petToxicity';
import { PublicShell } from '@/components/PublicShell';
import { headToTags, resolveHead } from '@/config/seo';
import { PlantSafetyArticle } from '@/features/petsafe/PlantSafetyArticle';
import {
  PLANT_SAFETY_PAGES,
  plantPageLastmod,
  plantSafetyMeta,
  type PlantSafetyPage,
} from '@/features/petsafe/plantSafetyPages';
import {
  checkPlantSafetyPageHtml,
  plantPageLastmods,
  // @ts-expect-error - vanilla ESM build script, deliberately untyped
} from '../../../scripts/check-plant-safety-pages.mjs';

afterEach(cleanup);

/** `<lastmod>` by path, parsed from the committed sitemap. */
const SITEMAP_LASTMOD = new Map<string, string>();
const sitemap = readFileSync(resolve(__dirname, '../../../public/sitemap.xml'), 'utf8');
for (const [, block] of sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
  const loc = block.match(/<loc>https:\/\/familygreenhouse\.net([^<]*)<\/loc>/)?.[1];
  const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
  if (loc && lastmod) SITEMAP_LASTMOD.set(loc, lastmod);
}

function webPage(page: PlantSafetyPage): Record<string, unknown> {
  const meta = plantSafetyMeta(page, i18next.t.bind(i18next) as never);
  const graph = (meta.jsonLd as { '@graph': Record<string, unknown>[] })['@graph'];
  return graph.find((node) => node['@type'] === 'WebPage')!;
}

/** A full document, as prerender.mjs would write it: the route's head plus the rendered body. */
function documentFor(page: PlantSafetyPage): string {
  const { container } = render(
    <MemoryRouter initialEntries={[`/pet-safe/${page.slug}`]}>
      <PublicShell width="article">
        <PlantSafetyArticle page={page} />
      </PublicShell>
    </MemoryRouter>
  );
  const meta = plantSafetyMeta(page, i18next.t.bind(i18next) as never);
  const head = headToTags(resolveHead(meta, `/pet-safe/${page.slug}`));
  const html = `<!doctype html><html><head>${head}</head><body>${container.innerHTML}</body></html>`;
  cleanup();
  return html;
}

function gate(html: string, slug: string, lastmods?: Map<string, string>): string[] {
  return checkPlantSafetyPageHtml({
    html,
    entry: PET_TOXICITY.find((e) => e.slug === slug),
    aspcaOrigin: ASPCA_ANIMAL_POISON_CONTROL_URL,
    ...(lastmods ? { lastmods } : {}),
  });
}

describe('dateModified on the pet-safety pages', () => {
  it('is the sitemap lastmod on every published page', () => {
    expect(PLANT_SAFETY_PAGES.length).toBeGreaterThanOrEqual(56);
    const differing = PLANT_SAFETY_PAGES.flatMap((page) => {
      const inSitemap = SITEMAP_LASTMOD.get(`/pet-safe/${page.slug}`);
      const onPage = webPage(page).dateModified;
      return inSitemap && onPage === inSitemap ? [] : [`${page.slug}: ${onPage} / ${inSitemap}`];
    });
    expect(differing).toEqual([]);
  });

  it('is a date the ledger recorded, not the day the test runs', () => {
    const today = new Date().toISOString().slice(0, 10);
    const dates = new Set(PLANT_SAFETY_PAGES.map((page) => webPage(page).dateModified));
    // Pages changed on different days, so one shared date would be a build stamp.
    expect(dates.size).toBeGreaterThan(1);
    for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...dates].every((date) => date === today)).toBe(false);
  });

  it('is absent, not blank or today, for a page with no recorded date', () => {
    expect(plantPageLastmod('no-such-plant')).toBeUndefined();
    // An inherited property name is not a ledger entry.
    expect(plantPageLastmod('constructor')).toBeUndefined();
    const page = { ...PLANT_SAFETY_PAGES[0]!, slug: 'no-such-plant' };
    const node = webPage(page);
    expect('dateModified' in node).toBe(false);
    expect(JSON.stringify(node)).not.toMatch(/dateModified/);
  });

  it('states nothing new about safety: only the date was added to the WebPage node', () => {
    const page = PLANT_SAFETY_PAGES.find((p) => p.slug === 'peace-lily')!;
    expect(Object.keys(webPage(page)).sort()).toEqual(
      [
        '@id',
        '@type',
        'about',
        'citation',
        'dateModified',
        'description',
        'inLanguage',
        'isPartOf',
        'name',
        'url',
      ].sort()
    );
  });
});

describe('the build gate holds the page date to the sitemap', () => {
  const page = PLANT_SAFETY_PAGES.find((p) => p.slug === 'peace-lily')!;
  const date = SITEMAP_LASTMOD.get('/pet-safe/peace-lily')!;

  it('control 0: the page as built passes, and the gate reads the same date', () => {
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(plantPageLastmods().get('/pet-safe/peace-lily')).toBe(date);
    expect(gate(documentFor(page), 'peace-lily')).toEqual([]);
  });

  it('a different date fails', () => {
    const html = documentFor(page);
    const sabotaged = html.replace(`"dateModified":"${date}"`, '"dateModified":"2026-12-25"');
    expect(sabotaged).not.toBe(html);
    expect(gate(sabotaged, 'peace-lily')).toEqual([
      `/pet-safe/peace-lily: JSON-LD WebPage.dateModified is "2026-12-25", but the sitemap's <lastmod> for this page is "${date}"`,
    ]);
  });

  it('a page that drops the date fails', () => {
    const html = documentFor(page);
    const sabotaged = html.replace(`"dateModified":"${date}",`, '');
    expect(sabotaged).not.toBe(html);
    expect(gate(sabotaged, 'peace-lily')).toEqual([
      `/pet-safe/peace-lily: JSON-LD WebPage.dateModified is undefined, but the sitemap's <lastmod> for this page is "${date}"`,
    ]);
  });

  it('a date on a page the sitemap does not date fails', () => {
    // What the gate sees once a table entry is edited and the ledger is not
    // re-run: the route loses its lastmod, and the page still prints the old one.
    const html = documentFor(page);
    const undated = new Map(plantPageLastmods() as Map<string, string>);
    expect(undated.delete('/pet-safe/peace-lily')).toBe(true);
    expect(gate(html, 'peace-lily', undated)).toEqual([
      `/pet-safe/peace-lily: JSON-LD WebPage.dateModified is "${date}", but the sitemap's <lastmod> for this page is undefined`,
    ]);
  });
});
