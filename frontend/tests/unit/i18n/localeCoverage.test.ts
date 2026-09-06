import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';
import { localeCoverage } from '@/i18n/coverage';

/**
 * Guard for the quality-audit risk register #3 ("localization content gap").
 *
 * Two invariants:
 *  1. Every non-English locale must define every key English does — a missing
 *     key means a silent English fallback, which we never want to ship blind.
 *     (scripts/check-i18n-catalogs.mjs enforces this — plus placeholder and
 *     plural-category parity — as a merge-blocking gate; this test keeps the
 *     invariant visible in the unit suite too.)
 *  2. Every non-English locale clears the coverage bar. Always.
 *
 * Invariant 2 used to be conditional: the assertion below sat behind
 * `if (!nonEnglishEnabled) return`, and VITE_ENABLE_NON_ENGLISH_LOCALES is set
 * in no CI job and no deployed environment, so the 95% bar had never been
 * evaluated in a single run (#467 §3). A gate that arms only on the build that
 * flips the flag is a gate that first reports on the day it is least welcome,
 * against a catalog that drifted unwatched in the meantime.
 *
 * So it runs unconditionally now. That is affordable because Spanish is not the
 * "partial scaffold" the old comments described: it is at 99.3% with zero
 * missing keys, and the ten values that equal the English source are
 * enumerated in locales/es/translation.todo.json as `intentionallyEqual`
 * (proper nouns, and words like "no" that are the same in both). The bar
 * ratchets that: a merge that lands new English keys with untranslated Spanish
 * counterparts fails here, in the run that introduces it, whether or not
 * anyone intends to ship Spanish soon.
 */

const NON_ENGLISH = { es } as const;
const COVERAGE_THRESHOLD = 0.95;

describe('locale coverage', () => {
  for (const [code, locale] of Object.entries(NON_ENGLISH)) {
    it(`${code} defines every key present in en (no silent fallbacks)`, () => {
      const report = localeCoverage(en, locale);
      expect(report.missingKeys).toEqual([]);
    });

    it(`${code} meets the ${COVERAGE_THRESHOLD * 100}% bar required to enable it`, () => {
      const report = localeCoverage(en, locale);
      const pct = (report.coverage * 100).toFixed(1);

      expect(
        report.coverage,
        `${code} is only ${pct}% translated (${report.translatedKeys}/${report.totalKeys}); ` +
          'translate the new keys before merging, or record them in ' +
          `locales/${code}/translation.todo.json if they are deliberately identical to English`
      ).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
    });
  }
});
