import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { i18n as I18nInstance } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import esTranslation from '@/i18n/locales/es/translation.json';
// The `.ts` extension is load-bearing (tsconfig.json enables
// allowImportingTsExtensions for it). `tsc -b` inside `npm run build` emits a
// sibling `vite.manualChunks.js` — gitignored, but real on disk — and Vite
// resolves an extensionless specifier to `.js` before `.ts`, so in any tree
// where a build has run (which includes `npm run verify`) the extensionless
// form silently tests the LAST BUILD's compiled rule instead of the source.
// That is the exact staleness vite.manualChunks.ts was extracted to avoid.
import { manualChunks } from '../../../vite.manualChunks.ts';

/**
 * The Spanish catalog is 104,586 bytes of JSON that no deployed build lets a
 * user select. It used to be a static import in src/i18n/index.ts, registered in
 * `resources`, and pinned by vite.manualChunks.ts into the modulepreloaded
 * `i18n` chunk — so every visitor downloaded and parsed all of it, on the
 * startup path, for a language the UI would not offer them (#467 §2).
 *
 * Measured on this branch: the startup `i18n` catalog chunk went 169,505 ->
 * 78,827 bytes raw, 42,317 -> 21,838 brotli, and the critical path (entry +
 * every modulepreload + CSS) 228.0 -> 207.8 kB brotli.
 *
 * These tests hold the split in place. It regresses silently in three ways,
 * and every one of them leaves Spanish working — which is why none of them
 * shows up as a failing feature test:
 *
 *   1. Someone re-adds `import es from './locales/es/translation.json'` to
 *      src/i18n/index.ts, or puts the catalog back into `resources`.
 *   2. The chunk rule in vite.manualChunks.ts widens back to `[\w-]+`, which
 *      pins the deferred catalog into the startup chunk anyway. This is the
 *      same trap #428 documented for legal.json: the dynamic import still
 *      resolves, the pages still render, and the bytes are back.
 *   3. The loader stops being a literal `import()` of a literal path — a
 *      variable path or a hoisted static import folds the catalogs into
 *      whatever imports the loader.
 */

// vitest runs with `frontend/` as cwd (see vitest.config.ts `root`).
const read = (rel: string) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');

/** Minimal stand-in for the parts of the i18next instance the loader touches. */
function fakeInstance() {
  const bundles = new Set<string>();
  return {
    added: [] as { lng: string; catalog: unknown }[],
    hasResourceBundle: (lng: string) => bundles.has(lng),
    addResourceBundle(lng: string, _ns: string, catalog: unknown) {
      bundles.add(lng);
      this.added.push({ lng, catalog });
    },
  };
}

type Fake = ReturnType<typeof fakeInstance>;
const asInstance = (fake: Fake) => fake as unknown as I18nInstance;

describe('deferred non-English catalogs', () => {
  describe('the startup path', () => {
    it('does not register Spanish on the shared instance at boot', () => {
      // The real module, initialised the way every visitor gets it: the
      // non-English opt-in is off under vitest, as in every deployed build.
      expect(i18n.hasResourceBundle('en', 'translation')).toBe(true);
      expect(i18n.hasResourceBundle('es', 'translation')).toBe(false);
    });

    it('is never imported eagerly by the module on every page load', () => {
      const index = read('i18n/index.ts');
      // English is the fallback catalog; every visitor needs it on first paint.
      expect(index).toMatch(/import en from '\.\/locales\/en\/translation\.json'/);
      // Any other locale is a staged asset and must not ride the entry chunk.
      expect(index).not.toMatch(/locales\/(?!en\/)[\w-]+\/translation\.json/);
      // Including via the loader, which must be reached through import().
      expect(index).not.toMatch(/^import .*nonEnglishCatalog/m);
      expect(index).toMatch(/import\('\.\/nonEnglishCatalog'\)/);
    });

    it('reaches each catalog through a literal import(), never a static one', () => {
      const loader = read('i18n/nonEnglishCatalog.ts');
      expect(loader).toMatch(/import\('\.\/locales\/es\/translation\.json'\)/);
      expect(loader).not.toMatch(/^import .*locales\//m);
    });

    it('is not swept back onto the startup path by a manualChunks rule', () => {
      // Run the real rule rollup is handed (see vite.manualChunks.ts for why
      // this is an import and not a source-text parse).
      const chunkFor = (lng: string) =>
        manualChunks(`/repo/frontend/src/i18n/locales/${lng}/translation.json`);

      expect(
        chunkFor('en'),
        'the startup-catalog rule in vite.manualChunks.ts stopped matching English, so it is not ' +
          'doing what its comment says. Pin locales/en/translation.json or drop the rule.'
      ).toBe('i18n');

      for (const lng of ['es', 'fr', 'pt-BR']) {
        expect(
          chunkFor(lng),
          `a manualChunks rule captures locales/${lng}/translation.json into ` +
            `'${String(chunkFor(lng))}', the startup catalog's chunk. That catalog is loaded on ` +
            'demand by src/i18n/nonEnglishCatalog.ts; naming it in a chunk rule folds it back ' +
            'onto the startup path, where every visitor downloads it to reach a language the UI ' +
            'does not offer them. Match locales/en/translation.json by name.'
        ).toBeUndefined();
      }

      // The rest of the rule chain, so this exercises the real function rather
      // than one branch of it, and a reordering that shadows the locales rule
      // shows up here.
      expect(manualChunks('/repo/frontend/node_modules/react-dom/client.js')).toBe('vendor');
      expect(manualChunks('/repo/frontend/src/App.tsx')).toBeUndefined();
    });
  });

  describe('the loader', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('publishes exactly the locales the catalogs directory has, minus English', async () => {
      const { NON_ENGLISH_CATALOGS } = await import('@/i18n/nonEnglishCatalog');
      expect([...NON_ENGLISH_CATALOGS]).toEqual(['es']);
    });

    it('loads the real catalog and merges it into the translation namespace', async () => {
      const { ensureLocaleCatalog } = await import('@/i18n/nonEnglishCatalog');
      const fake = fakeInstance();

      await ensureLocaleCatalog(asInstance(fake), 'es');

      expect(fake.added).toHaveLength(1);
      expect(fake.added[0].lng).toBe('es');
      // The whole catalog, not a fragment: a partial merge would render some
      // keys in Spanish and silently fall the rest back to English.
      expect(fake.added[0].catalog).toEqual(esTranslation);
    });

    it('resolves a regional code against its base catalog', async () => {
      const { ensureLocaleCatalog } = await import('@/i18n/nonEnglishCatalog');
      const fake = fakeInstance();

      await ensureLocaleCatalog(asInstance(fake), 'es-MX');

      // Registered as `es`, which is where i18next's resolve hierarchy for
      // es-MX looks before falling back to English.
      expect(fake.added.map((entry) => entry.lng)).toEqual(['es']);
    });

    it('loads once for concurrent callers and not at all once registered', async () => {
      const { ensureLocaleCatalog } = await import('@/i18n/nonEnglishCatalog');
      const fake = fakeInstance();
      const addSpy = vi.spyOn(fake, 'addResourceBundle');

      await Promise.all([
        ensureLocaleCatalog(asInstance(fake), 'es'),
        ensureLocaleCatalog(asInstance(fake), 'es-AR'),
      ]);
      await ensureLocaleCatalog(asInstance(fake), 'es');

      expect(addSpy).toHaveBeenCalledTimes(1);
    });

    it('never loads anything for English', async () => {
      const { ensureLocaleCatalog } = await import('@/i18n/nonEnglishCatalog');
      const fake = fakeInstance();

      await ensureLocaleCatalog(asInstance(fake), 'en');
      await ensureLocaleCatalog(asInstance(fake), 'en-GB');

      expect(fake.added).toEqual([]);
    });

    it('rejects for a locale with no catalog instead of reporting one it cannot render', async () => {
      const { ensureLocaleCatalog } = await import('@/i18n/nonEnglishCatalog');
      const fake = fakeInstance();

      await expect(ensureLocaleCatalog(asInstance(fake), 'fr')).rejects.toThrow(
        "no catalog is published for 'fr'"
      );
      expect(fake.added).toEqual([]);
    });
  });
});
