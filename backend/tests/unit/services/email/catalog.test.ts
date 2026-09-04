/**
 * The gate for the email catalog.
 *
 * Every i18n check in CI (`check-i18n-catalogs.mjs`, the hardcoded-string
 * ratchet, the localeCoverage test) scans `frontend/` only, so none of them
 * sees `backend/src/services/email/catalog.ts`. This file is its guard, and
 * it enforces the same three rules the frontend gate does: key parity (G6),
 * placeholder parity (G5), and exactly the CLDR plural categories each locale
 * requires (G5). It runs in the same `npm run verify` chain.
 */
import { describe, expect, it } from 'vitest';
import {
  EMAIL_LOCALES,
  __catalogs,
  formatCount,
  formatDaysAgo,
  formatYear,
  isEmailLocale,
  t,
  tn,
  type EmailLocale,
} from '../../../../src/services/email/catalog.js';

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL_RE = new RegExp(`^(.*)_(${PLURAL_SUFFIXES.join('|')})$`);

function splitPlural(key: string): { base: string; category: string | null } {
  const m = PLURAL_RE.exec(key);
  return m ? { base: m[1], category: m[2] } : { base: key, category: null };
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]).sort();
}

function logicalKeys(locale: EmailLocale): Set<string> {
  return new Set(Object.keys(__catalogs[locale]).map((k) => splitPlural(k).base));
}

describe('email catalog parity', () => {
  it('ships exactly the locales the app ships', () => {
    expect([...EMAIL_LOCALES]).toEqual(['en', 'es']);
    expect(isEmailLocale('en')).toBe(true);
    expect(isEmailLocale('fr')).toBe(false);
    expect(isEmailLocale(undefined)).toBe(false);
  });

  it('has the same logical keys in every locale (G6)', () => {
    const base = logicalKeys('en');
    for (const locale of EMAIL_LOCALES) {
      if (locale === 'en') continue;
      const other = logicalKeys(locale);
      const missing = [...base].filter((k) => !other.has(k));
      const extra = [...other].filter((k) => !base.has(k));
      expect(missing, `${locale} is missing keys`).toEqual([]);
      expect(extra, `${locale} has keys en does not`).toEqual([]);
    }
  });

  it('carries exactly the CLDR plural categories each locale requires (G5)', () => {
    for (const locale of EMAIL_LOCALES) {
      const required = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
      const groups = new Map<string, Set<string>>();
      for (const key of Object.keys(__catalogs[locale])) {
        const { base, category } = splitPlural(key);
        if (!category) continue;
        if (!groups.has(base)) groups.set(base, new Set());
        groups.get(base)!.add(category);
      }
      for (const [base, categories] of groups) {
        expect([...categories].sort(), `${locale}:${base}`).toEqual([...required].sort());
      }
    }
  });

  it('uses the same interpolation variables for a key in every locale (G5)', () => {
    for (const [key, englishValue] of Object.entries(__catalogs.en)) {
      const { base, category } = splitPlural(key);
      for (const locale of EMAIL_LOCALES) {
        if (locale === 'en') continue;
        const catalog = __catalogs[locale];
        const value = category ? (catalog[key] ?? catalog[`${base}_other`]) : catalog[key];
        expect(value, `${locale} has no value for ${key}`).toBeDefined();
        expect(placeholders(value as string), `${locale}:${key} placeholders`).toEqual(
          placeholders(englishValue)
        );
      }
    }
  });

  it('has no Spanish value byte-identical to its English source', () => {
    // The frontend gate makes this declarable via translation.todo.json. This
    // catalog has no todo file because it has no untranslated strings, and
    // this assertion is what keeps that true.
    const identical = Object.keys(__catalogs.en).filter(
      (key) => __catalogs.es[key] !== undefined && __catalogs.es[key] === __catalogs.en[key]
    );
    expect(identical).toEqual([]);
  });
});

describe('lookup', () => {
  it('interpolates named variables', () => {
    expect(t('en', 'footer.reason.household', { household: 'The Kim House' })).toContain(
      'The Kim House'
    );
    expect(t('es', 'footer.reason.household', { household: 'The Kim House' })).toContain(
      'The Kim House'
    );
  });

  it('returns the key and logs when a key is missing, never an empty string', () => {
    // An empty string would silently drop a line from a household's email.
    expect(t('en', 'nope.not.here')).toBe('nope.not.here');
  });

  it('selects the English one/other categories', () => {
    expect(tn('en', 'digest.moreWaiting', 1)).toBe('And 1 more plant is waiting.');
    expect(tn('en', 'digest.moreWaiting', 4)).toBe('And 4 more plants are waiting.');
  });

  it('selects the Spanish one/many/other categories — which a ternary cannot', () => {
    const rules = new Intl.PluralRules('es');
    expect(rules.select(1)).toBe('one');
    expect(tn('es', 'digest.moreWaiting', 1)).toBe('Y 1 planta más está esperando.');
    expect(tn('es', 'digest.moreWaiting', 4)).toBe('Y 4 plantas más están esperando.');
  });

  it('formats counts and relative days through Intl, never by concatenation', () => {
    expect(formatCount('en', 1234)).toBe('1,234');
    expect(formatCount('es', 1234)).toBe('1234');
    expect(formatDaysAgo('en', 11)).toBe('11 days ago');
    expect(formatDaysAgo('en', 1)).toBe('yesterday');
    expect(formatDaysAgo('en', 0)).toBe('today');
    expect(formatDaysAgo('es', 11)).toBe('hace 11 días');
    expect(formatDaysAgo('es', 0)).toBe('hoy');
  });

  it('renders a year without digit grouping — 2025, not 2,025', () => {
    expect(formatYear('en', 2025)).toBe('2025');
    expect(formatYear('es', 2025)).toBe('2025');
  });

  it('never renders NaN as a number of days', () => {
    expect(formatDaysAgo('en', Number.NaN)).toBe('today');
  });
});
