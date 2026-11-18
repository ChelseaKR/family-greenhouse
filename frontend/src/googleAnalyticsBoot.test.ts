/**
 * The document-level GA start (googleAnalyticsBoot.ts): that it tells gtag.js
 * exactly what the app's loader tells it, stays off under every condition the
 * loader stays off under, sends a page view only for a prerendered public page
 * whose address is the one being loaded, and hands over to the loader so the
 * first page is counted once.
 *
 * The boot runs on import, so each case resets the module registry and imports
 * it afresh. As in googleAnalytics.test.ts, every negative case first proves
 * its sabotage landed, and the positive control is what makes them mean
 * anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANALYTICS_OPT_OUT_STORAGE_KEY } from './services/analytics';
import { useAuthStore } from './store/authStore';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import { publicRoutePaths } from '../scripts/public-routes.mjs';

const ID = 'G-L2JN3PQ75P';
const GTAG_SCRIPT = 'script[src^="https://www.googletagmanager.com/gtag/js"]';

type Loader = typeof import('./services/googleAnalytics');

async function boot(): Promise<void> {
  vi.resetModules();
  await import('./googleAnalyticsBoot');
}

async function loader(): Promise<Loader> {
  return import('./services/googleAnalytics');
}

function gtagScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>(GTAG_SCRIPT)];
}

/** The dataLayer as plain arrays, so assertions can use toEqual. */
function commands(): unknown[][] {
  return (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
}

function pageViews(): Array<Record<string, unknown>> {
  const all = commands();
  const views: Array<Record<string, unknown>> = [];
  all.forEach((command, index) => {
    if (command[0] === 'event' && command[1] === 'page_view') {
      const set = all[index - 1];
      expect(set?.[0], 'every page_view is preceded by the set that scrubs it').toBe('set');
      views.push(set?.[1] as Record<string, unknown>);
    }
  });
  return views;
}

/** A page as scripts/prerender.mjs emits it: #root stamped with its route. */
function prerendered(path: string, title = `${path} — Family Greenhouse`): void {
  const root = document.createElement('div');
  root.id = 'root';
  root.dataset.prerendered = path;
  document.body.appendChild(root);
  document.title = title;
}

/** The app shell: an empty #root with no stamp. */
function shell(): void {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
}

function visit(pathAndQuery: string): void {
  window.history.replaceState(null, '', pathAndQuery);
}

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { value, configurable: true });
}

function setGpc(value: unknown) {
  Object.defineProperty(globalThis.navigator, 'globalPrivacyControl', {
    value,
    configurable: true,
  });
}

function setDnt(value: string | null) {
  Object.defineProperty(globalThis.navigator, 'doNotTrack', { value, configurable: true });
}

function reset() {
  vi.unstubAllEnvs();
  setDnt(null);
  setGpc(undefined);
  setReferrer('');
  localStorage.clear();
  delete (window as { Capacitor?: unknown }).Capacitor;
  delete window.dataLayer;
  delete window.__fgGoogleAnalyticsBoot;
  for (const script of gtagScripts()) script.remove();
  delete (window as unknown as Record<string, unknown>)[`ga-disable-${ID}`];
  document.getElementById('root')?.remove();
  document.title = '';
  visit('/');
}

beforeEach(() => {
  reset();
  vi.stubEnv('VITE_GA_MEASUREMENT_ID', ID);
});

afterEach(reset);

describe('what the boot tells Google Analytics', () => {
  it('starts GA and sends the page view of a prerendered page (positive control)', async () => {
    visit('/care/monstera?utm_source=newsletter&utm_campaign=fall&ref=FRIEND42');
    prerendered('/care/monstera', 'Monstera care: how often to water it');
    setReferrer('https://www.google.com/search?q=monstera+watering');

    await boot();

    const scripts = gtagScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
    expect(scripts[0].async).toBe(true);
    for (const entry of window.dataLayer ?? []) {
      expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]');
    }
    const origin = window.location.origin;
    expect(pageViews()).toEqual([
      {
        page_location: `${origin}/care/monstera?utm_source=newsletter&utm_campaign=fall`,
        page_title: 'Monstera care: how often to water it',
        page_referrer: 'https://www.google.com/',
      },
    ]);
    expect(JSON.stringify(commands())).not.toContain('FRIEND42');
    expect(window.__fgGoogleAnalyticsBoot).toEqual({
      id: ID,
      pageLocation: `${origin}/care/monstera?utm_source=newsletter&utm_campaign=fall`,
    });
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${ID}`]).toBe(false);
  });

  it('gives gtag.js exactly the consent defaults and configuration the loader gives it', async () => {
    shell();
    await boot();
    const fromBoot = commands();
    expect(fromBoot.length, 'the boot configured GA').toBeGreaterThan(0);

    // A fresh page where the boot did not run, and the loader does it all.
    reset();
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', ID);
    vi.resetModules();
    const ga = await loader();
    expect(ga.initGoogleAnalytics()).toBe(true);
    const fromLoader = commands();

    const withoutClock = (list: unknown[][]) =>
      list.map((command) => (command[0] === 'js' ? ['js', '<Date>'] : command));
    expect(withoutClock(fromBoot)).toEqual(withoutClock(fromLoader));
    const js = fromBoot.find((command) => command[0] === 'js');
    expect(js?.[1]).toBeInstanceOf(Date);
  });

  it('shares the address rules with the loader: campaign tags only, in its order', async () => {
    visit('/care/pothos?ref=FRIEND42&utm_campaign=fall&email=a%40b.co&utm_source=ads');
    prerendered('/care/pothos');
    await boot();
    const ga = await loader();
    expect(window.__fgGoogleAnalyticsBoot?.pageLocation).toBe(
      ga.gaPageLocation(window.location.origin, window.location.pathname, window.location.search)
    );
    expect(window.__fgGoogleAnalyticsBoot?.pageLocation).toBe(
      `${window.location.origin}/care/pothos?utm_source=ads&utm_campaign=fall`
    );
  });

  it('reduces a referrer to its origin, our own included', async () => {
    visit('/care/pothos');
    prerendered('/care/pothos');
    setReferrer(`${window.location.origin}/sit/abc123def456abc123def456abc123def456/brief`);
    await boot();
    expect(pageViews()[0]?.page_referrer).toBe(`${window.location.origin}/`);
    expect(JSON.stringify(commands())).not.toContain('abc123def456');
  });

  it('falls back to the generic title when the document has none', async () => {
    visit('/care');
    prerendered('/care', '');
    await boot();
    const ga = await loader();
    expect(pageViews()[0]?.page_title).toBe(ga.GENERIC_PAGE_TITLE);
  });
});

describe('when the boot sends no page view', () => {
  it('still starts GA on the app shell, and leaves the page view to the app', async () => {
    visit('/dashboard');
    shell();
    await boot();
    expect(gtagScripts()).toHaveLength(1);
    expect(commands().some((command) => command[0] === 'config')).toBe(true);
    expect(pageViews()).toEqual([]);
    expect(window.__fgGoogleAnalyticsBoot).toEqual({ id: ID, pageLocation: null });
  });

  it('sends none when the stamp is not the address being loaded', async () => {
    visit('/care/pothos');
    prerendered('/care/monstera');
    await boot();
    expect(pageViews()).toEqual([]);
  });

  it('sends none for a trailing slash, which the loader would scrub differently', async () => {
    visit('/care/monstera/');
    prerendered('/care/monstera');
    await boot();
    expect(pageViews()).toEqual([]);
  });

  it.each([
    '/sit/abc123',
    '/join/0b6f7c1e11114222833394444555666',
    '/shared/0b6f7c1e11114222833394444555666',
    '/caretaker/abc123',
    '/plants/0b6f7c1e-1111-4222-8333-944445555666',
    '/households/42',
    '/Care/monstera',
    '/care/Monstera_deliciosa',
  ])('sends none for a stamp the loader would scrub: %s', async (path) => {
    visit(path);
    prerendered(path);
    await boot();
    expect(pageViews()).toEqual([]);
    expect(window.__fgGoogleAnalyticsBoot?.pageLocation).toBeNull();
  });

  it('sends one for every published route, at the address the loader would send', async () => {
    const routes = publicRoutePaths() as string[];
    expect(routes.length).toBeGreaterThan(100);
    const ga = await loader();
    for (const route of routes) {
      reset();
      vi.stubEnv('VITE_GA_MEASUREMENT_ID', ID);
      visit(route);
      prerendered(route);
      await boot();
      expect(
        pageViews().map((view) => view.page_location),
        route
      ).toEqual([ga.gaPageLocation(window.location.origin, route, '')]);
      expect(ga.gaPagePath(route), `${route} is sent verbatim by the loader too`).toBe(route);
    }
  });

  it('sends none for the home page when the browser is signed in', async () => {
    visit('/');
    prerendered('/');
    localStorage.setItem(
      useAuthStore.persist.getOptions().name!,
      JSON.stringify({ state: { isAuthenticated: true }, version: 0 })
    );
    await boot();
    expect(pageViews()).toEqual([]);
    expect(window.__fgGoogleAnalyticsBoot?.pageLocation).toBeNull();
  });

  it('sends one for the home page when the browser is signed out (control)', async () => {
    visit('/');
    prerendered('/');
    await boot();
    expect(pageViews()).toHaveLength(1);
  });

  it('reads the key the auth store actually persists under', () => {
    expect(useAuthStore.persist.getOptions().name).toBe('auth-storage');
  });
});

describe('when the boot does nothing at all', () => {
  function expectOff() {
    expect(gtagScripts()).toEqual([]);
    expect(window.dataLayer).toBeUndefined();
    expect(window.__fgGoogleAnalyticsBoot).toBeUndefined();
  }

  it('without a measurement ID', async () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    prerendered('/');
    await boot();
    expectOff();
  });

  it('with a malformed one', async () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'UA-12345-6');
    prerendered('/');
    await boot();
    expectOff();
  });

  it('under Global Privacy Control', async () => {
    setGpc(true);
    prerendered('/');
    await boot();
    expectOff();
  });

  it('under Do Not Track', async () => {
    setDnt('1');
    prerendered('/');
    await boot();
    expectOff();
  });

  it('when the in-app analytics switch is off, under the key analytics.ts writes', async () => {
    localStorage.setItem(ANALYTICS_OPT_OUT_STORAGE_KEY, '1');
    prerendered('/');
    await boot();
    expectOff();
  });

  it('inside the Capacitor shell', async () => {
    (window as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    prerendered('/');
    await boot();
    expectOff();
  });

  it('a second time on the same page', async () => {
    prerendered('/');
    await boot();
    const once = commands();
    expect(once.length).toBeGreaterThan(0);
    await boot();
    expect(commands()).toEqual(once);
    expect(gtagScripts()).toHaveLength(1);
  });
});

describe('handing over to the app', () => {
  it('the loader adopts the boot: no second configuration, no second script, first page counted once', async () => {
    visit('/care/monstera');
    prerendered('/care/monstera', 'Monstera care');
    await boot();
    const booted = commands();
    const ga = await loader();

    expect(ga.initGoogleAnalytics()).toBe(true);
    expect(commands()).toEqual(booted);
    expect(gtagScripts()).toHaveLength(1);

    // GoogleAnalyticsPageViews fires for the route being loaded: already sent.
    ga.trackGooglePageView('/care/monstera', '', 'Monstera care');
    expect(pageViews()).toHaveLength(1);

    // The next route is new, and refers back to the page the boot counted.
    ga.trackGooglePageView('/care', '', 'Care guides');
    expect(pageViews()).toHaveLength(2);
    expect(pageViews()[1]).toEqual({
      page_location: `${window.location.origin}/care`,
      page_title: 'Care guides',
      page_referrer: `${window.location.origin}/care/monstera`,
    });
  });

  it('the loader sends the first page view itself when the boot sent none', async () => {
    visit('/dashboard');
    shell();
    await boot();
    const ga = await loader();
    ga.initGoogleAnalytics();
    ga.trackGooglePageView('/dashboard', '', 'Dashboard');
    expect(pageViews()).toHaveLength(1);
  });

  it('a boot that arrives after the loader does nothing: GA is configured once either way', async () => {
    visit('/care/monstera');
    prerendered('/care/monstera', 'Monstera care');
    vi.resetModules();
    const ga = await loader();
    expect(ga.initGoogleAnalytics()).toBe(true);
    ga.trackGooglePageView('/care/monstera', '', 'Monstera care');
    const started = commands();
    expect(window.__fgGoogleAnalyticsBoot).toEqual({ id: ID, pageLocation: null });

    await import('./googleAnalyticsBoot');

    expect(commands()).toEqual(started);
    expect(gtagScripts()).toHaveLength(1);
    expect(pageViews()).toHaveLength(1);
  });

  it('the loader ignores a boot for another measurement ID (negative control)', async () => {
    visit('/care/monstera');
    prerendered('/care/monstera');
    await boot();
    window.__fgGoogleAnalyticsBoot = { id: 'G-OTHER0000', pageLocation: null };
    const ga = await loader();
    ga.initGoogleAnalytics();
    expect(gtagScripts()).toHaveLength(2);
    expect(commands().filter((command) => command[0] === 'config')).toHaveLength(2);
  });
});
