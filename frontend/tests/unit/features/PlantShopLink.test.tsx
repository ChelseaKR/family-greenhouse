/**
 * The "Buy this plant" link as rendered on the public plant pages (ADR 0038).
 *
 * Three things matter and each has a test here:
 *   1. With no affiliate id configured, the pages are exactly what they were:
 *      the configured render, minus the shop block, equals the unconfigured
 *      render byte for byte, so the block is the only thing the feature adds.
 *   2. Every rendered shop link carries rel="sponsored noopener" and a visible
 *      "Paid link" label beside it.
 *   3. It never appears inside the iOS or Android app, and never on a
 *      /pet-safe page that calls the plant toxic or cannot say.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import i18next from 'i18next';
import type { ReactNode } from 'react';

const config = vi.hoisted(() => ({ theSill: '', bloomscape: '' }) as Record<string, string>);
vi.mock('@/config/affiliateLinks.json', () => ({ default: config }));

import { PublicShell } from '@/components/PublicShell';
import { headToTags, resolveHead } from '@/config/seo';
import { CareGuidePage } from '@/features/care/CareGuidePage';
import { CARE_GUIDE_SLUGS } from '@/features/care/careGuideSlugs';
import { PlantSafetyArticle } from '@/features/petsafe/PlantSafetyArticle';
import {
  PLANT_SAFETY_PAGES,
  findPlantSafetyPage,
  plantSafetyMeta,
  type PlantSafetyPage,
} from '@/features/petsafe/plantSafetyPages';
import plantShopLinks from '@/features/plantShop/plantShopLinks.json';
import {
  ASPCA_ANIMAL_POISON_CONTROL_URL,
  PET_TOXICITY,
} from '../../../../backend/src/models/petToxicity';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import { checkPlantSafetyPageHtml } from '../../../scripts/check-plant-safety-pages.mjs';

const SILL = 'https://thesill.pxf.io/c/1234567/123456/12345';
const BLOOM = 'https://bloomscape.pxf.io/c/1234567/654321/54321';

function configure(values: Record<string, string>) {
  config.theSill = values.theSill ?? '';
  config.bloomscape = values.bloomscape ?? '';
}

afterEach(() => {
  cleanup();
  configure({});
  delete (window as { Capacitor?: unknown }).Capacitor;
});

function careHtml(slug: string): string {
  const { container } = render(
    <MemoryRouter initialEntries={[`/care/${slug}`]}>
      <Routes>
        <Route path="/care/:slug" element={<CareGuidePage />} />
      </Routes>
    </MemoryRouter>
  );
  const html = container.innerHTML;
  cleanup();
  return html;
}

function petSafeHtml(page: PlantSafetyPage): string {
  return renderBody(page, <PlantSafetyArticle page={page} />);
}

function renderBody(page: PlantSafetyPage, body: ReactNode): string {
  const { container } = render(
    <MemoryRouter initialEntries={[`/pet-safe/${page.slug}`]}>
      <PublicShell width="article">{body}</PublicShell>
    </MemoryRouter>
  );
  const html = container.innerHTML;
  cleanup();
  return html;
}

/** The same markup with the shop block taken out, as the DOM serializes it. */
function withoutShopBlock(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('[data-plant-shop]').forEach((el) => el.remove());
  return doc.body.innerHTML;
}

const LINKED = Object.keys(plantShopLinks.links);
const CARE = [...CARE_GUIDE_SLUGS];

describe('with no affiliate id configured, nothing changes', () => {
  it.each(CARE)('/care/%s', (slug) => {
    const before = careHtml(slug);
    expect(before).not.toContain('data-plant-shop');
    expect(before).not.toContain('sponsored');
    configure({ theSill: SILL, bloomscape: BLOOM });
    const after = careHtml(slug);
    expect(withoutShopBlock(after)).toBe(before);
    expect(after.includes('data-plant-shop')).toBe(LINKED.includes(slug));
  });

  it.each(PLANT_SAFETY_PAGES.map((p) => [p.slug, p] as const))('/pet-safe/%s', (_slug, page) => {
    const before = petSafeHtml(page);
    expect(before).not.toContain('data-plant-shop');
    configure({ theSill: SILL, bloomscape: BLOOM });
    expect(withoutShopBlock(petSafeHtml(page))).toBe(before);
  });
});

describe('a rendered shop link', () => {
  it('has rel="sponsored noopener", a visible "Paid link" label and the disclosure', () => {
    configure({ theSill: SILL });
    const { container } = render(
      <MemoryRouter initialEntries={['/care/monstera']}>
        <Routes>
          <Route path="/care/:slug" element={<CareGuidePage />} />
        </Routes>
      </MemoryRouter>
    );
    const blocks = container.querySelectorAll('[data-plant-shop]');
    expect(blocks).toHaveLength(1);
    const a = blocks[0]!.querySelector('a')!;
    expect(a.getAttribute('rel')).toBe('sponsored noopener');
    expect(a.getAttribute('href')).toBe(
      `${SILL}?u=${encodeURIComponent('https://www.thesill.com/products/monstera-deliciosa')}`
    );
    expect(a.textContent).toBe('Buy this plant at The Sill');
    // The label sits in the same line as the link, not in a footer.
    expect(a.parentElement!.querySelector('[data-chrome="plantShop.paidLink"]')!.textContent).toBe(
      'Paid link'
    );
    expect(blocks[0]!.textContent).toContain('earns a commission');
  });

  it('every link on every page carries the label and rel', () => {
    configure({ theSill: SILL, bloomscape: BLOOM });
    const pages = [
      ...CARE.map((slug) => careHtml(slug)),
      ...PLANT_SAFETY_PAGES.map((page) => petSafeHtml(page)),
    ];
    let links = 0;
    for (const html of pages) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const a of doc.querySelectorAll('a[rel~="sponsored"]')) {
        links += 1;
        expect(a.closest('[data-plant-shop]')).not.toBeNull();
        expect(a.getAttribute('rel')).toBe('sponsored noopener');
        expect(a.parentElement!.querySelector('[data-chrome="plantShop.paidLink"]')).not.toBeNull();
      }
      // No shop link escapes the labeled block.
      for (const block of doc.querySelectorAll('[data-plant-shop]')) {
        expect(block.querySelectorAll('a')).toHaveLength(1);
      }
    }
    expect(links).toBeGreaterThan(0);
  });

  it('is not rendered inside the iOS or Android app', () => {
    configure({ theSill: SILL, bloomscape: BLOOM });
    (window as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    for (const slug of LINKED.filter((s) => CARE_GUIDE_SLUGS.has(s))) {
      expect(careHtml(slug)).not.toContain('data-plant-shop');
    }
    for (const page of PLANT_SAFETY_PAGES) {
      expect(petSafeHtml(page)).not.toContain('data-plant-shop');
    }
  });

  it('appears on a /pet-safe page only when every verdict is non-toxic', () => {
    configure({ theSill: SILL, bloomscape: BLOOM });
    let shown = 0;
    for (const page of PLANT_SAFETY_PAGES) {
      const html = petSafeHtml(page);
      const allNonToxic = Object.values(page.claims).every((c) => c.state === 'non-toxic');
      if (html.includes('data-plant-shop')) {
        shown += 1;
        expect(allNonToxic, page.slug).toBe(true);
      } else if (allNonToxic) {
        expect(LINKED, page.slug).not.toContain(page.slug);
      }
    }
    expect(shown).toBeGreaterThan(0);
    // Monstera is toxic to cats and dogs and has a checked product page.
    expect(petSafeHtml(findPlantSafetyPage('monstera')!)).not.toContain('data-plant-shop');
  });
});

describe('the /pet-safe build gate and the shop link', () => {
  const entryFor = (slug: string) => PET_TOXICITY.find((e) => e.slug === slug)!;
  const shop = { config: { theSill: SILL, bloomscape: BLOOM }, links: plantShopLinks.links };

  function documentFor(page: PlantSafetyPage, body?: ReactNode): string {
    const html = renderBody(page, body ?? <PlantSafetyArticle page={page} />);
    const meta = plantSafetyMeta(page, i18next.t.bind(i18next) as never);
    const head = headToTags(resolveHead(meta, `/pet-safe/${page.slug}`));
    return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  }

  function gate(html: string, slug: string, shopArg: unknown = shop): string[] {
    return checkPlantSafetyPageHtml({
      html,
      entry: entryFor(slug),
      aspcaOrigin: ASPCA_ANIMAL_POISON_CONTROL_URL,
      shop: shopArg,
    });
  }

  it('passes every page with the link configured', () => {
    configure({ theSill: SILL, bloomscape: BLOOM });
    for (const page of PLANT_SAFETY_PAGES) {
      expect(gate(documentFor(page), page.slug), page.slug).toEqual([]);
    }
  });

  it('fails a link the config does not account for', () => {
    configure({ theSill: SILL, bloomscape: BLOOM });
    const page = findPlantSafetyPage('money-tree')!;
    const html = documentFor(page);
    expect(html).toContain('data-plant-shop');
    const failures = gate(html, 'money-tree', { config: {}, links: plantShopLinks.links });
    expect(failures.join('\n')).toContain('not the configured product page');
  });

  it('fails a link with its "Paid link" label removed', () => {
    configure({ theSill: SILL, bloomscape: BLOOM });
    const html = documentFor(findPlantSafetyPage('money-tree')!);
    const sabotaged = html.replace(
      /<span data-chrome="plantShop\.paidLink"[^>]*>[^<]*<\/span>/,
      ''
    );
    expect(sabotaged).not.toBe(html);
    expect(gate(sabotaged, 'money-tree').join('\n')).toContain('no visible "Paid link" label');
  });

  it('fails a link without rel="sponsored"', () => {
    configure({ theSill: SILL, bloomscape: BLOOM });
    const html = documentFor(findPlantSafetyPage('money-tree')!);
    const sabotaged = html.replace('rel="sponsored noopener"', 'rel="noopener"');
    expect(sabotaged).not.toBe(html);
    expect(gate(sabotaged, 'money-tree').join('\n')).toContain('expected "sponsored noopener"');
  });

  it('fails a shop block on a page that calls the plant toxic', () => {
    configure({ theSill: SILL, bloomscape: BLOOM });
    const safe = documentFor(findPlantSafetyPage('money-tree')!);
    const block = /<div data-plant-shop="money-tree".*?<\/p><\/div>/s.exec(safe)![0];
    const toxic = documentFor(findPlantSafetyPage('monstera')!);
    const sabotaged = toxic.replace(
      '</article>',
      `${block.replace(/money-tree/g, 'monstera')}</article>`
    );
    expect(sabotaged).not.toBe(toxic);
    expect(gate(sabotaged, 'monstera').join('\n')).toContain('not every verdict on the page');
  });
});
