import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import i18n from '@/i18n';
import { isLegalCatalogLoaded, loadLegalCatalog } from '@/i18n/legalCatalog';
import enLegal from '@/i18n/locales/en/legal.json';
import esLegal from '@/i18n/locales/es/legal.json';
import enTranslation from '@/i18n/locales/en/translation.json';
import esTranslation from '@/i18n/locales/es/translation.json';

/**
 * The `legal.*` copy is deliberately NOT in the startup catalog: it is ~37 kB
 * of prose that only /legal/privacy, /legal/terms, /support and
 * /account-deletion read, and shipping it to every visitor is what pushed
 * `All-JS-combined` over budget (see the size-limit notes in
 * frontend/package.json).
 *
 * These tests hold that split in place. Two ways it silently regresses:
 *
 *   1. A merge (or a well-meaning refactor) puts a `legal` block back into
 *      translation.json — the keys still resolve, so nothing looks broken, and
 *      the bytes are back on the startup path.
 *   2. Something imports legalCatalogChunk.ts statically, which folds the chunk
 *      into whatever imports it. If that importer is on the startup path, so is
 *      the prose.
 */

// vitest runs with `frontend/` as cwd (see vitest.config.ts `root`).
const read = (rel: string) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');

/** Every leaf key, dotted, so key sets can be compared across locales/files. */
function leafKeys(tree: unknown, prefix = '', out: string[] = []): string[] {
  if (typeof tree !== 'object' || tree === null) return out;
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push(path);
    else leafKeys(value, path, out);
  }
  return out;
}

describe('deferred legal catalog', () => {
  it('is absent from the startup catalogs in every locale', () => {
    expect(enTranslation).not.toHaveProperty('legal');
    expect(esTranslation).not.toHaveProperty('legal');
    expect(leafKeys(enTranslation).filter((k) => k.startsWith('legal.'))).toEqual([]);
    expect(leafKeys(esTranslation).filter((k) => k.startsWith('legal.'))).toEqual([]);
  });

  it('carries the same 116 keys in both locales, all rooted at `legal.`', () => {
    const en = leafKeys(enLegal).sort();
    const es = leafKeys(esLegal).sort();
    expect(en).toEqual(es);
    // 101 when the fragment was split out, +15 for the commercial terms
    // (trial, renewal, cancellation, price changes, one-time purchases).
    expect(en).toHaveLength(116);
    expect(en.every((k) => k.startsWith('legal.'))).toBe(true);
  });

  it('registers both locales on the shared instance when loaded', async () => {
    await loadLegalCatalog();

    for (const lng of ['en', 'es'] as const) {
      expect(isLegalCatalogLoaded(lng)).toBe(true);
      for (const key of leafKeys(lng === 'en' ? enLegal : esLegal)) {
        expect(i18n.getResource(lng, 'translation', key), `${lng}/${key}`).toBeTypeOf('string');
      }
    }
    // The startup keys are still there — the fragment merges, it doesn't replace.
    expect(i18n.getResource('en', 'translation', 'nav')).toBeTypeOf('object');
  });

  it('memoizes so four legal routes share one chunk load', async () => {
    expect(loadLegalCatalog()).toBe(loadLegalCatalog());
  });

  it('is not swept into a startup chunk by a manualChunks rule', () => {
    // A `manualChunks` rule that matches `src/i18n/locales/` by path captures
    // legal.json too, which puts the prose back into whatever chunk the startup
    // catalog lives in. Nothing fails: the dynamic import still resolves, the
    // pages still render, and the split is silently undone. Measured against
    // PR #419's `i18n` pin, the deferred chunk collapsed to 154 B and the whole
    // catalog reappeared inside a modulepreloaded chunk. So any rule naming the
    // locales directory has to say something about `legal` — an exclusion.
    const config = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    // `\\?` because the rule is written as a regex literal, where the path
    // separators are escaped: /src\/i18n\/locales\//.
    if (/i18n\\?\/locales/.test(config)) {
      expect(
        config,
        'vite.config.ts pins src/i18n/locales/ to a manual chunk but never mentions legal: ' +
          'that rule also captures locales/<lng>/legal.json and puts the deferred prose back ' +
          'on the startup path. Exclude the legal fragments from the rule.'
      ).toMatch(/legal/);
    }
  });

  it('is never imported eagerly: the chunk module has exactly one importer', () => {
    // src/i18n/index.ts is on every page's critical path; a static import of
    // either the chunk or the JSON there undoes the whole split.
    const index = read('i18n/index.ts');
    expect(index).not.toMatch(/from\s+'\.\/legalCatalogChunk'/);
    expect(index).not.toMatch(/locales\/(en|es)\/legal\.json/);

    // App.tsx may import the loader (it does), but never the chunk itself.
    const app = read('App.tsx');
    expect(app).toMatch(/from\s+'@\/i18n\/legalCatalog'/);
    expect(app).not.toMatch(/legalCatalogChunk/);

    // And the loader itself reaches it only through a dynamic import().
    const loader = read('i18n/legalCatalog.ts');
    expect(loader).toMatch(/await import\('\.\/legalCatalogChunk'\)/);
    expect(loader).not.toMatch(/^import .*legalCatalogChunk/m);
  });
});
