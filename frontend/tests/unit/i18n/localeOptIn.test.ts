import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The non-English opt-in (src/i18n/index.ts, `readNonEnglishOptIn`).
 *
 * `?locales=on` writes a localStorage flag so an internal tester can exercise
 * Spanish without a rebuild. It had no mirror: nothing in the app cleared that
 * key again, so the only way back out of the opt-in was editing localStorage by
 * hand in devtools, and a tester who forgot stayed on a Spanish-capable build
 * on that device indefinitely. `?locales=off` is that mirror.
 *
 * These read the module fresh each time because the opt-in is evaluated once,
 * at import, and drives `SUPPORTED_LANGS` for the life of the page.
 */

const LS_KEY = 'feature:non_english_locales';

async function importI18n(search: string) {
  vi.resetModules();
  vi.stubGlobal('location', { ...window.location, search, href: `http://localhost/${search}` });
  return import('@/i18n');
}

describe('non-English locale opt-in', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.resetModules();
  });

  it('offers English only by default', async () => {
    const { SUPPORTED_LANGS } = await importI18n('');
    expect([...SUPPORTED_LANGS]).toEqual(['en']);
    expect(window.localStorage.getItem(LS_KEY)).toBeNull();
  });

  it('`?locales=on` offers Spanish and persists the choice for this device', async () => {
    const { SUPPORTED_LANGS } = await importI18n('?locales=on');
    expect([...SUPPORTED_LANGS]).toEqual(['en', 'es']);
    expect(window.localStorage.getItem(LS_KEY)).toBe('true');
  });

  it('remembers the opt-in on a later load with no query string', async () => {
    window.localStorage.setItem(LS_KEY, 'true');
    const { SUPPORTED_LANGS } = await importI18n('');
    expect([...SUPPORTED_LANGS]).toEqual(['en', 'es']);
  });

  it('`?locales=off` clears the stored opt-in, not just this page load', async () => {
    window.localStorage.setItem(LS_KEY, 'true');

    const { SUPPORTED_LANGS } = await importI18n('?locales=off');

    expect([...SUPPORTED_LANGS]).toEqual(['en']);
    // The stored flag is gone, so the NEXT load with no query string is
    // English too — which is the whole point. Without this the tester is stuck.
    expect(window.localStorage.getItem(LS_KEY)).toBeNull();
    const next = await importI18n('');
    expect([...next.SUPPORTED_LANGS]).toEqual(['en']);
  });

  it('does not load a catalog for a language the build does not offer', async () => {
    const { default: instance, ensureLanguageCatalog } = await importI18n('');

    await ensureLanguageCatalog('es');

    // No-op rather than a rejection: callers ask for the active language
    // without needing to know which build they are in, and a build that does
    // not offer Spanish has already pinned them to English.
    expect(instance.hasResourceBundle('es', 'translation')).toBe(false);
  });

  it('loads the catalog for a language the build does offer', async () => {
    const { default: instance, ensureLanguageCatalog } = await importI18n('?locales=on');

    await ensureLanguageCatalog('es');

    expect(instance.hasResourceBundle('es', 'translation')).toBe(true);
    expect(instance.getResource('es', 'translation', 'common.save')).toBe('Guardar');
  });

  it('boots a Spanish-speaking visitor into Spanish, catalog and all', async () => {
    // The whole point of the split: the catalog is no longer in the bundle, so
    // a visitor the detector lands on `es` for depends on the boot path in
    // index.ts loading it. If that regressed nothing would look broken — the
    // app would render English, which is what it renders for everyone else.
    //
    // Driven through `navigator`, not the stored `i18nextLng`: the localStorage
    // half of i18next-browser-languagedetector does not resolve under this
    // jsdom setup (verified — `detect()` returns the navigator codes only,
    // even with the key present), so a localStorage-driven version of this test
    // would assert nothing.
    window.localStorage.setItem(LS_KEY, 'true');
    vi.stubGlobal('navigator', {
      ...window.navigator,
      languages: ['es-ES', 'es'],
      language: 'es-ES',
    });

    const { default: instance } = await importI18n('');

    // Wait on the positive end state, then assert what it produced.
    await vi.waitFor(() => expect(instance.hasResourceBundle('es', 'translation')).toBe(true), {
      // The boot load is fire-and-forget; under vitest the first transform of
      // the 104 kB catalog module is what takes the time, not the app.
      timeout: 10_000,
    });

    expect(instance.language).toBe('es');
    expect(instance.t('common.save')).toBe('Guardar');
    // `resolvedLanguage` is fixed when the language is set, before the catalog
    // exists; it must be re-settled, or the app reports English while
    // rendering Spanish.
    expect(instance.resolvedLanguage).toBe('es');
  });
});
