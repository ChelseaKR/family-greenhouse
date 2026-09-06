import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PLAN_PRICES } from '@/features/pricing/planPrices';

/**
 * The drift gate for `frontend/src/features/pricing/planPrices.ts`.
 *
 * That module is a hand-written mirror of the backend plan catalog, and it is
 * published to crawlers as Offer markup on /pricing. A mirror nobody checks is
 * how this repository ended up advertising a 10-plant free tier for seven
 * weeks after it became 20 (#643) — twice, on two surfaces. Here the stale
 * value would be a PRICE, sitting in Google's results while checkout refuses
 * it.
 *
 * So the catalog is read off disk and compared field by field. Changing a
 * price in the backend without updating the mirror fails this suite, and the
 * failure names the tier and the field.
 *
 * It parses the source rather than importing it: `backend/` is a separate
 * workspace with its own tsconfig and is not on the frontend's module graph,
 * and adding it would let backend code into the client bundle to keep a test
 * honest. The parser is deliberately narrow, and the first test below proves
 * it actually matched something — a regex that quietly stops matching would
 * otherwise turn this whole file green.
 */

// vitest runs with `frontend/` as its cwd; the catalog is one level up.
const CATALOG_PATH = 'backend/src/models/plans.ts';
const MIRROR_PATH = 'frontend/src/features/pricing/planPrices.ts';

const source = readFileSync(resolve(process.cwd(), '..', CATALOG_PATH), 'utf8');

interface CatalogPrice {
  id: string;
  name: string;
  monthly: number | null;
  annual: number | null;
  lifetime: number | null;
  withdrawn: string[];
}

/** The catalog with its comments removed — they quote amounts in prose. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The body of `export const PLANS = { … }`, comments already stripped. */
function plansBlock(): string {
  const stripped = withoutComments(source);
  const start = stripped.indexOf('export const PLANS');
  const end = stripped.indexOf('\n};', start);
  if (start === -1 || end === -1) {
    throw new Error(`could not find the PLANS catalog in ${CATALOG_PATH}`);
  }
  return stripped.slice(start, end);
}

function amount(section: string, key: string): number | null {
  const match = new RegExp(`\\b${key}:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(section);
  return match ? Number(match[1]) : null;
}

function parseCatalog(): CatalogPrice[] {
  const block = plansBlock();
  // Each tier is a two-space-indented key whose object closes at the same
  // indent; the nested `limits` / `features` objects are indented deeper and
  // so cannot end a section early.
  const sections = block.matchAll(/^ {2}([a-z]+): \{$([\s\S]*?)^ {2}\},$/gm);
  return [...sections].map(([, id, section]) => ({
    id,
    name: /\bname:\s*'([^']*)'/.exec(section)?.[1] ?? '',
    monthly: amount(section, 'monthlyPrice'),
    annual: amount(section, 'annualPrice'),
    lifetime: amount(section, 'lifetimePrice'),
    withdrawn: [
      ...(/\bwithdrawnIntervals:\s*\[([^\]]*)\]/.exec(section)?.[1] ?? '').matchAll(/'([a-z]+)'/g),
    ].map(([, interval]) => interval),
  }));
}

describe('the published price mirror', () => {
  const catalog = parseCatalog();

  it('parses real amounts out of the catalog, so a broken regex cannot pass this file', () => {
    expect(catalog.length, `no tiers parsed from ${CATALOG_PATH}`).toBeGreaterThan(0);
    for (const plan of catalog) {
      expect(plan.name.length, `${plan.id} has no name in ${CATALOG_PATH}`).toBeGreaterThan(0);
      expect(
        Number.isFinite(plan.monthly),
        `${plan.id} has no monthlyPrice in ${CATALOG_PATH}`
      ).toBe(true);
    }
    expect(
      catalog.some((plan) => (plan.monthly ?? 0) > 0),
      `no paid tier parsed from ${CATALOG_PATH}`
    ).toBe(true);
  });

  it('names exactly the tiers the catalog does', () => {
    expect(PLAN_PRICES.map((plan) => plan.id)).toEqual(catalog.map((plan) => plan.id));
  });

  it('states the same amount as the catalog at every cadence', () => {
    for (const plan of catalog) {
      const mirrored = PLAN_PRICES.find((entry) => entry.id === plan.id);
      expect(
        mirrored,
        `${plan.id} is in ${CATALOG_PATH} but missing from ${MIRROR_PATH}`
      ).toBeDefined();
      const drift = `${plan.id}: ${MIRROR_PATH} has drifted from ${CATALOG_PATH}`;
      expect(mirrored!.name, `${drift} — name`).toBe(plan.name);
      expect(mirrored!.monthly, `${drift} — monthlyPrice`).toBe(plan.monthly);
      expect(mirrored!.annual, `${drift} — annualPrice`).toBe(plan.annual);
      expect(mirrored!.lifetime, `${drift} — lifetimePrice`).toBe(plan.lifetime);
    }
  });

  it('knows the same cadences have been withdrawn from sale', () => {
    // A cadence still priced but no longer sold (ADR 0012) must not reach an
    // Offer: checkout refuses it, so advertising it promises a purchase the
    // API declines. Putting one back on sale has to update the mirror too.
    for (const plan of catalog) {
      const mirrored = PLAN_PRICES.find((entry) => entry.id === plan.id)!;
      expect(
        [...mirrored.withdrawn].sort(),
        `${plan.id}: ${MIRROR_PATH} has drifted from ${CATALOG_PATH} — withdrawnIntervals`
      ).toEqual([...plan.withdrawn].sort());
    }
  });
});
