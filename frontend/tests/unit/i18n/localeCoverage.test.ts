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
 *  2. A locale may only be *enabled* (VITE_ENABLE_NON_ENGLISH_LOCALES=true)
 *     once it clears the coverage bar. Seed locales are intentionally partial,
 *     so when the flag is off we only report coverage; when a build flips it
 *     on, this test fails unless the locale is genuinely ready.
 */

const NON_ENGLISH = { es } as const;
const COVERAGE_THRESHOLD = 0.95;
const nonEnglishEnabled = import.meta.env.VITE_ENABLE_NON_ENGLISH_LOCALES === 'true';

describe('locale coverage', () => {
  for (const [code, locale] of Object.entries(NON_ENGLISH)) {
    it(`${code} defines every key present in en (no silent fallbacks)`, () => {
      const report = localeCoverage(en, locale);
      expect(report.missingKeys).toEqual([]);
    });

    it(`${code} meets the ${COVERAGE_THRESHOLD * 100}% bar required to enable it`, () => {
      const report = localeCoverage(en, locale);
      const pct = (report.coverage * 100).toFixed(1);

      if (!nonEnglishEnabled) {
        // Locale is gated off — report coverage but don't fail the build. The
        // bar is enforced on the build that turns the flag on, which is the
        // exact moment we must not ship a half-translated UI.
        // eslint-disable-next-line no-console
        console.info(
          `[i18n] ${code} coverage ${pct}% (${report.translatedKeys}/${report.totalKeys}) — gate inactive (locale disabled)`
        );
        return;
      }

      expect(
        report.coverage,
        `${code} is only ${pct}% translated; finish it before enabling non-English locales`
      ).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
    });
  }
});
