/**
 * Rollup `manualChunks` for the browser build.
 *
 * The rules live here, in a plain side-effect-free module, rather than inline
 * in vite.config.ts, so that the build and the test suite run the SAME
 * function. tests/unit/i18n/legalCatalog.test.ts holds the invariant that the
 * deferred `legal.json` catalog is not swept back onto the startup path, and
 * two earlier shapes of that test could not run the real rule:
 *
 *   1. `await import('../../../vite.config')` inside vitest returns a config
 *      Vite has already bundled and cached. Measured: a config patched to
 *      return a sentinel chunk name still came back from that import as the
 *      PREVIOUS build's rule, so the guard passed on a config it had never
 *      read — a vacuous gate.
 *   2. Reading vite.config.ts as text and lifting the `/…/.test(id)`
 *      predicates back out with a regex did read the current file, but
 *      extracting regex literals needs an alternation over escapes and
 *      character classes that is ambiguous by construction, which is the
 *      polynomial backtracking CodeQL flags as js/redos.
 *
 * An importable module has neither problem: vitest transforms it from disk on
 * every run, and there is no source text left to parse. Keep it dependency-
 * free — vite.config.ts is bundled by esbuild before Vite starts, and this is
 * imported into a jsdom test worker; anything with side effects pays in both
 * places.
 */
export function manualChunks(id: string): string | undefined {
  // Keep the React runtime in a single long-lived vendor chunk.
  // A string-array manualChunks entry (['react', 'react-dom', ...])
  // stopped capturing all of react-dom's submodules under React 19,
  // which leaked the runtime into the entry chunk and ballooned it.
  // Matching on the resolved node_modules path is version-robust.
  if (/node_modules\/(react|react-dom|scheduler|react-router)\//.test(id)) {
    return 'vendor';
  }
  if (/node_modules\/@tanstack\/react-query\//.test(id)) {
    return 'query';
  }
  if (/node_modules\/(@headlessui\/react|@heroicons\/react)\//.test(id)) {
    return 'ui';
  }
  // Pin the STARTUP translation catalogs to their own chunk.
  // Rollup already extracts them most of the time, but that is an
  // emergent property of the module graph, not a rule, and it
  // flips on unrelated merges. Measured, same source, one worktree,
  // one npm ci: with this branch on base 98b44398, dropping this
  // line folded both catalogs into the entry chunk and took
  // `Initial JS` 17.91 -> 57.16 kB brotli without a line of new
  // startup code; one merge later (#423) the identical source split
  // cleanly again and the line was worth 6 B. Naming the chunk turns
  // that coin flip into a stated invariant, which is what the
  // vendor/query/ui rules above already do.
  //
  // What it does NOT do is bound the critical path. `Initial JS`
  // globs dist/assets/index-*.js only, and dist/index.html
  // modulepreloads six more chunks — vendor, ui, query, api,
  // authStore and this one — so the flip above moved 27 kB between
  // two files a visitor downloads either way (measured critical
  // path 191.8 vs 191.9 kB). Read a swing in `Initial JS` as chunk
  // boundaries moving until the preload set says otherwise.
  //
  // ALLOWLIST, NOT DENYLIST. This matches `translation.json` by
  // name rather than matching the locales directory and excluding
  // what must not be captured. #428 moved the privacy/terms/
  // support/account-deletion prose into `locales/<lng>/legal.json`
  // so that src/i18n/legalCatalog.ts can pull it in on demand; a
  // path-wide rule swallows that fragment back onto the startup
  // path silently, because the dynamic import still resolves and
  // the pages still render (tests/unit/i18n/legalCatalog.test.ts
  // is what catches it). Every future deferred namespace would
  // need another exclusion; matching the one file that is loaded
  // at startup needs none.
  //
  // ENGLISH ONLY, for the same reason. `[\w-]+` here used to capture every
  // locale, which pinned the Spanish catalog into this startup chunk too —
  // 86.6 kB of JSON downloaded by every visitor for a language SUPPORTED_LANGS
  // does not offer them (#467). src/i18n/nonEnglishCatalog.ts now `import()`s
  // the non-English catalogs on demand, and a rule that names them by pattern
  // would silently undo that split exactly the way a locales-wide rule undid
  // the legal one: the dynamic import still resolves, Spanish still renders,
  // and the bytes are back on the startup path. English is the fallback
  // catalog every visitor needs on first paint, so it is the startup catalog
  // and it is the only one named here.
  if (/src\/i18n\/locales\/en\/translation\.json$/.test(id)) {
    return 'i18n';
  }
  return undefined;
}
