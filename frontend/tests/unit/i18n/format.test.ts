/**
 * Locale-aware formatting. The point of these helpers is that no caller ever
 * passes a locale in normal use — they read i18next's active language — so
 * both the override path and the "follow the active language" path matter.
 */
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { formatCurrency, formatDate, formatRelativeDay, formatTime } from '@/i18n/format';

afterEach(async () => {
  await i18n.changeLanguage('en');
  i18n.removeResourceBundle('es', 'translation');
});

describe('formatDate', () => {
  it('formats an ISO string in the requested locale', () => {
    expect(formatDate('2026-05-12T15:00:00Z', { timeZone: 'UTC' }, 'en-US')).toBe('May 12, 2026');
    expect(formatDate('2026-05-12T15:00:00Z', { timeZone: 'UTC' }, 'es-MX')).toBe('12 may 2026');
  });

  it('accepts a Date and lets callers override the field set', () => {
    expect(formatDate(new Date(2026, 4, 12), { month: 'long', day: undefined }, 'en-US')).toBe(
      'May 2026'
    );
  });

  it('returns an empty string for null, undefined, and unparseable input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('not a date')).toBe('');
  });

  it('follows the active i18next language when no override is given', async () => {
    // Register a Spanish bundle first. i18next only lets `changeLanguage(l)`
    // stick when either `l` is in `supportedLngs` or the store already has some
    // translations for it (i18next.js `changeLanguage` → `setLng`), and this
    // build's `supportedLngs` is `['en']` — Spanish is a staged asset, fetched
    // on demand (src/i18n/nonEnglishCatalog.ts), not bundled. This test used to
    // pass only because the Spanish catalog was statically imported into
    // `resources` for every visitor, which is the 104 kB #467 was about.
    i18n.addResourceBundle('es', 'translation', { common: { yes: 'Sí' } }, true, true);
    await i18n.changeLanguage('es');

    expect(formatDate('2026-05-12T15:00:00Z', { timeZone: 'UTC' })).toBe('12 may 2026');
  });
});

describe('formatTime', () => {
  it('uses locale conventions for the clock', () => {
    const at = new Date(2026, 4, 12, 15, 5);

    expect(formatTime(at, 'en-US')).toMatch(/3:05\s?PM/iu);
    expect(formatTime(at.toISOString(), 'en-GB')).toMatch(/15:05/u);
  });
});

describe('formatCurrency', () => {
  it('defaults to USD and honors an explicit currency', () => {
    expect(formatCurrency(4.99, undefined, 'en-US')).toBe('$4.99');
    expect(formatCurrency(4.99, 'MXN', 'es-MX')).toContain('4.99');
  });
});

describe('formatRelativeDay', () => {
  it('describes today, tomorrow, and yesterday in words', () => {
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);

    expect(formatRelativeDay(today, 'en-US')).toBe('today');
    expect(formatRelativeDay(tomorrow, 'en-US')).toBe('tomorrow');
    expect(formatRelativeDay(yesterday, 'en-US')).toBe('yesterday');
  });

  it('counts whole calendar days for more distant dates', () => {
    const today = new Date();
    const inFive = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 5);

    expect(formatRelativeDay(inFive.toISOString(), 'en-US')).toBe('in 5 days');
  });
});
