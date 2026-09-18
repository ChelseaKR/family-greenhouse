import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spanish is reachable (#467), through the two paths the app already had: the
 * i18next language detector (`navigator.languages`) and the Settings picker,
 * which renders whenever `SUPPORTED_LANGS` offers more than one locale.
 *
 * These read the module fresh each time because detection and the kill switch
 * are evaluated once, at import, and hold for the life of the page.
 */

async function importI18n() {
  vi.resetModules();
  return import('@/i18n');
}

function browserLanguages(...languages: string[]) {
  vi.stubGlobal('navigator', { ...window.navigator, languages, language: languages[0] });
}

describe('non-English locales are reachable', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    window.localStorage.clear();
    vi.resetModules();
  });

  it('offers English and Spanish in a default build', async () => {
    const { SUPPORTED_LANGS } = await importI18n();
    expect([...SUPPORTED_LANGS]).toEqual(['en', 'es']);
  });

  it('boots a Spanish-speaking visitor into Spanish, catalog and all', async () => {
    // The catalog is not in the bundle, so a visitor the detector lands on `es`
    // for depends on the boot path in index.ts loading it. If that regressed
    // nothing would look broken — the app would render English, which is what
    // it renders for everyone else.
    browserLanguages('es-ES', 'es');

    const { default: instance, bootCatalogReady } = await importI18n();
    // The real boot-time load, not a poll for its result.
    await bootCatalogReady;

    expect(instance.language).toBe('es');
    expect(instance.hasResourceBundle('es', 'translation')).toBe(true);
    expect(instance.t('common.save')).toBe('Guardar');
    // `resolvedLanguage` is fixed when the language is set, before the catalog
    // exists; it must be re-settled, or the app reports English while
    // rendering Spanish.
    expect(instance.resolvedLanguage).toBe('es');
  });

  it('resolves a regional Spanish tag to the es catalog', async () => {
    browserLanguages('es-MX');

    const { default: instance, bootCatalogReady } = await importI18n();
    await bootCatalogReady;

    expect(instance.language).toBe('es');
    expect(instance.t('common.save')).toBe('Guardar');
  });

  it('does not fetch Spanish for an English-first visitor', async () => {
    // The browser lists Spanish, but second: the visitor's first choice wins,
    // and the Spanish chunk is never requested on their behalf. Without
    // `convertDetectedLanguage` this boots into Spanish — i18next prefers the
    // exact supported code 'es' over the language-only match for 'en-US'.
    browserLanguages('en-US', 'es');

    const { default: instance, bootCatalogReady } = await importI18n();
    await bootCatalogReady;

    expect(instance.language).toBe('en');
    expect(instance.hasResourceBundle('es', 'translation')).toBe(false);
  });

  it('leaves a returning visitor in the English the detector cached for them', async () => {
    // While Spanish was off, the detector resolved every visitor to 'en' and
    // cached that in `i18nextLng`. Detection reads that key before
    // `navigator`, so someone already using the app in English is not
    // switched to Spanish by this change, whatever their browser says.
    window.localStorage.setItem('i18nextLng', 'en');
    browserLanguages('es-ES', 'es');

    const { default: instance, bootCatalogReady } = await importI18n();
    await bootCatalogReady;

    expect(instance.language).toBe('en');
    expect(instance.hasResourceBundle('es', 'translation')).toBe(false);
  });

  it('honours a stored Spanish choice over an English browser', async () => {
    window.localStorage.setItem('i18nextLng', 'es');
    browserLanguages('en-US', 'en');

    const { default: instance, bootCatalogReady } = await importI18n();
    await bootCatalogReady;

    expect(instance.language).toBe('es');
    expect(instance.t('common.save')).toBe('Guardar');
  });

  it('loads the catalog when the picker asks for it', async () => {
    const { default: instance, ensureLanguageCatalog } = await importI18n();

    await ensureLanguageCatalog('es');

    expect(instance.hasResourceBundle('es', 'translation')).toBe(true);
    expect(instance.getResource('es', 'translation', 'common.save')).toBe('Guardar');
  });

  describe('the kill switch, VITE_ENABLE_NON_ENGLISH_LOCALES=false', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_ENABLE_NON_ENGLISH_LOCALES', 'false');
    });

    it('offers English only', async () => {
      const { SUPPORTED_LANGS } = await importI18n();
      expect([...SUPPORTED_LANGS]).toEqual(['en']);
    });

    it('keeps a Spanish-speaking visitor on English and never loads the catalog', async () => {
      browserLanguages('es-ES', 'es');

      const { default: instance, bootCatalogReady, ensureLanguageCatalog } = await importI18n();
      await bootCatalogReady;
      // No-op rather than a rejection: callers ask for the active language
      // without needing to know which build they are in.
      await ensureLanguageCatalog('es');

      expect(instance.language).toBe('en');
      expect(instance.hasResourceBundle('es', 'translation')).toBe(false);
    });
  });
});
