/**
 * The `legal.*` copy, in one deferred chunk.
 *
 * This module exists ONLY to be `import()`ed by `legalCatalog.ts`. It must
 * never be imported statically from anywhere, or the prose it holds lands back
 * in the startup catalog and the whole split is undone —
 * `tests/unit/i18n/legalCatalog.test.ts` asserts that no other module imports
 * it eagerly.
 *
 * Both locales sit in the same module on purpose. The Spanish catalog is a
 * key-for-key translation of the English one, so the two compress far better
 * side by side in one chunk than they do as two: 10.75 kB brotli together
 * versus 11.34 kB apart (measured 2026-09-03).
 */
import en from './locales/en/legal.json';
import es from './locales/es/legal.json';

/** Locale code → the `{ legal: … }` fragment merged into `translation`. */
export const legalCatalogs = { en, es } as const;

export default legalCatalogs;
