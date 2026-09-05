import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import i18n from '@/i18n';
import { isLegalCatalogLoaded, loadLegalCatalog } from '@/i18n/legalCatalog';
import enLegal from '@/i18n/locales/en/legal.json';
import esLegal from '@/i18n/locales/es/legal.json';
import enTranslation from '@/i18n/locales/en/translation.json';
import esTranslation from '@/i18n/locales/es/translation.json';

// `.ts` extension deliberate — see the note in ./nonEnglishCatalog.test.ts.
// Without it this guard reads the compiled sibling `tsc -b` leaves behind, so
// after any build it reports on the previous build's rule.
import { manualChunks } from '../../../vite.manualChunks.ts';

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
    // catalog reappeared inside a modulepreloaded chunk.
    //
    // Run the real rule. Two earlier shapes of this check did not:
    //
    //   - a text search for the word `legal` in vite.config.ts, which any
    //     comment satisfied without the rule doing anything;
    //   - `await import('../../../vite.config')`, which — measured — handed
    //     back a config Vite had already bundled and cached, so a config
    //     patched to return a sentinel chunk name still reported the previous
    //     build's rule.
    //
    // Lifting the `/…/.test(id)` predicates back out of the config's SOURCE
    // TEXT fixed the staleness, but parsing regex literals needs an
    // alternation over escapes and character classes that is ambiguous by
    // construction — the polynomial backtracking CodeQL flags as js/redos.
    // vite.manualChunks.ts exists so there is nothing left to parse: the
    // import below is the exact function rollup is handed.
    const chunkFor = (file: string) => manualChunks(`/repo/frontend/src/i18n/locales/en/${file}`);
    const startupChunk = chunkFor('translation.json');
    const legalChunk = chunkFor('legal.json');

    expect(
      startupChunk,
      'the locales rule in vite.manualChunks.ts no longer captures the startup catalog, so it ' +
        'is not doing what it says. Pin locales/<lng>/translation.json or drop the rule.'
    ).toBeTypeOf('string');
    expect(
      legalChunk,
      `a manualChunks rule captures locales/<lng>/legal.json into '${String(startupChunk)}', the ` +
        'same chunk as the startup catalog. That prose is loaded on demand by ' +
        'src/i18n/legalCatalog.ts; naming it in a chunk rule folds it back onto the startup ' +
        'path. Match translation.json by name, or exclude the legal fragments.'
    ).not.toBe(startupChunk);

    // The rest of the rule chain, so this exercises the real function rather
    // than one branch of it — and so a reordering that shadows the locales
    // rule shows up here.
    expect(manualChunks('/repo/frontend/node_modules/react-dom/client.js')).toBe('vendor');
    expect(manualChunks('/repo/frontend/node_modules/@tanstack/react-query/build/x.js')).toBe(
      'query'
    );
    expect(manualChunks('/repo/frontend/node_modules/@headlessui/react/dist/x.js')).toBe('ui');
    expect(manualChunks('/repo/frontend/src/App.tsx')).toBeUndefined();

    // And the config still delegates here, so the module cannot quietly become
    // dead code while an inline rule does the real chunking. Plain substring
    // checks over whitespace-collapsed source — no pattern to backtrack.
    const config = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')
      .split(/\s+/)
      .join(' ');
    expect(config).toContain("import { manualChunks } from './vite.manualChunks'");
    expect(config).toContain('manualChunks: isSsrBuild ? undefined : manualChunks');
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
