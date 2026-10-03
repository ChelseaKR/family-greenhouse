import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MORE_DESTINATIONS,
  MORE_SUPPORT,
  NATIVE_TABS,
  SIGN_IN_AND_SETUP_PATHS,
  SETTINGS_LIST_GROUPS,
  SETTINGS_LIST_PATH,
  SETTINGS_ROW_PREFIX,
  SIGN_OUT_ID,
  UNMAPPED_PREFIXES,
  buildConfiguration,
  buildUpdate,
  chromeForPath,
  isTabRoot,
  sameTitle,
  tabForPath,
  type NativeChromeEvents,
  type NativeChromeUpdate,
} from '@/config/nativeFrame';
import type { NativeBarToolsEvents } from '@/config/nativeBarTools';
import { hasNativeFrame, markNativeFrame, nativeSwitchRole } from '@/lib/platform';
import {
  NATIVE_SETTINGS_SECTIONS,
  settingsSectionPath,
} from '@/features/settings/settingsSections';

/**
 * The iOS app's native frame, from the web's side: the route -> tab map, and
 * the contract between config/nativeFrame.ts and the Swift that reads it
 * (ios/App/App/NativeChromePlugin.swift). Swift is not compiled in CI, so,
 * like nativeBackSwipe.test.ts, this reads the Swift source: rename a field
 * on one side and forget the other, and this fails instead of the bar
 * quietly showing nothing.
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const app = read('src/App.tsx');
const layout = read('src/components/Layout.tsx');
const plugin = read('ios/App/App/NativeChromePlugin.swift');
const main = read('ios/App/App/MainViewController.swift');
const controller = read('ios/App/App/NativeFrameController.swift');
const model = read('ios/App/App/NativeFrameModel.swift');
const t = (key: string) => key;

const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);

function under(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

describe('route -> tab map', () => {
  it('has the five tabs the owner chose, in order', () => {
    expect(NATIVE_TABS.map((tab) => tab.id)).toEqual([
      'home',
      'plants',
      'tasks',
      'household',
      'more',
    ]);
    for (const tab of NATIVE_TABS) {
      expect(tab.selectedSymbol, `${tab.id} selected symbol is the filled form`).toBe(
        `${tab.symbol}.fill`
      );
    }
  });

  it('roots every tab on a real route in App.tsx (More on its native list)', () => {
    for (const tab of NATIVE_TABS) {
      if (tab.root === null) {
        expect(tab.id).toBe('more');
        continue;
      }
      expect(routes, `${tab.id} root ${tab.root}`).toContain(tab.root);
      expect(tabForPath(tab.root)).toBe(tab.id);
      expect(isTabRoot(tab.root)).toBe(true);
    }
  });

  it('decides every route in App.tsx: a tab, deliberately none, or no bars', () => {
    expect(routes.length).toBeGreaterThan(40);
    const undecided = routes.filter((route) => {
      const path = route.replace(/\/:[^/]+.*$/, '') || '/';
      if (route === '*') return false;
      if (tabForPath(path) !== null) return false;
      if (UNMAPPED_PREFIXES.some((p) => under(path, p))) return false;
      if (chromeForPath(path, { signedIn: true, hasHousehold: true }) === 'none') return false;
      return true;
    });
    expect(undecided, 'routes with no decision in config/nativeFrame.ts').toEqual([]);
  });

  it('maps details to their tab and leaves unmapped pages in the tab they opened in', () => {
    expect(tabForPath('/plants/abc')).toBe('plants');
    expect(tabForPath('/plants/abc/passport')).toBe('plants');
    expect(tabForPath('/plants/new')).toBe('plants');
    expect(tabForPath('/household/caretaker-report')).toBe('household');
    expect(tabForPath('/settings/billing')).toBe('more');
    expect(tabForPath('/today')).toBe('more');
    expect(tabForPath('/help/getting-started')).toBe('more');
    expect(tabForPath('/plantsfoo')).toBeNull();
    expect(tabForPath('/care/monstera')).toBeNull();
    expect(tabForPath('/dashboard/')).toBe('home');
  });

  it('shows no bars on sign-in, setup, the redirecting root and the wall display', () => {
    const signedIn = { signedIn: true, hasHousehold: true };
    for (const path of SIGN_IN_AND_SETUP_PATHS) {
      expect(chromeForPath(path, signedIn), path).toBe('none');
      expect(routes, `${path} is a route`).toContain(path);
    }
    expect(chromeForPath('/', signedIn)).toBe('none');
    expect(chromeForPath('/kiosk/token', signedIn)).toBe('none');
    expect(chromeForPath('/dashboard', { signedIn: false, hasHousehold: false })).toBe('none');
    expect(chromeForPath('/dashboard', { signedIn: true, hasHousehold: false })).toBe('none');
    expect(chromeForPath('/dashboard', signedIn)).toBe('tabs');
    expect(chromeForPath('/help', signedIn)).toBe('tabs');
  });

  it('names the same sign-in and setup screens as BackSwipePolicy', () => {
    const block = main.match(/signInAndSetupPaths: Set<String> = \[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    const swift = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect([...SIGN_IN_AND_SETUP_PATHS].sort()).toEqual(swift);
  });
});

describe('More keeps every drawer destination', () => {
  it('has a tab or a More row for every link in the web drawer, and Sign out', () => {
    const drawer = [...layout.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    expect(drawer.length).toBeGreaterThanOrEqual(9);
    // Settings is reached through its native list, whose rows open the pages.
    const more = [
      ...[...MORE_DESTINATIONS, ...MORE_SUPPORT].map((d) => d.path),
      ...buildConfiguration(t, [], null).settings.sections.flatMap((s) =>
        s.items.map((i) => i.path)
      ),
    ];
    for (const href of drawer) {
      const covered = NATIVE_TABS.some((tab) => tab.root === href) || more.includes(href);
      expect(covered, `drawer link ${href}`).toBe(true);
    }
    expect(layout).toContain("t('nav.signOut')");
    const config = buildConfiguration(t, [], null);
    const ids = config.moreSections.flatMap((s) => s.items.map((i) => i.id));
    expect(ids).toContain(SIGN_OUT_ID);
    // Chat and Today are shown to everyone; the web pages explain the plan.
    expect(ids).toEqual(
      expect.arrayContaining(['today', 'chat', 'analytics', 'settings', 'help', 'about'])
    );
  });

  it('lists the households, the active one checked, with Add a household', () => {
    const config = buildConfiguration(
      t,
      [
        { householdId: 'a', name: 'Fernwood' },
        { householdId: 'b', name: 'Cabin' },
      ],
      'b'
    );
    const households = config.moreSections[0];
    expect(households.title).toBe('nav.households');
    expect(households.items.map((i) => [i.id, i.checked ?? false])).toEqual([
      ['household:a', false],
      ['household:b', true],
      ['addHousehold', false],
    ]);
    const signOut = config.moreSections.at(-1)!.items[0];
    expect(signOut).toMatchObject({ id: 'signOut', destructive: true });
  });
});

describe('update messages', () => {
  const session = { signedIn: true, hasHousehold: true };
  const base = { key: 'k1', navigationType: 'PUSH' as const, session, t };

  it('a tab root: large title from the tab, no back, its trailing button', () => {
    const update = buildUpdate({ ...base, pathname: '/plants', search: '', pageTitle: 'Plants' });
    expect(update).toEqual<NativeChromeUpdate>({
      path: '/plants',
      key: 'k1',
      title: 'nav.plants',
      tab: 'plants',
      canGoBack: false,
      largeTitle: true,
      chrome: 'tabs',
      navigation: 'push',
      rightButton: { id: 'addPlant', symbol: 'plus', label: 'plants.addPlant' },
    });
  });

  it('a detail: the page h1 as title, a way back, no large title', () => {
    const update = buildUpdate({
      ...base,
      pathname: '/plants/p1',
      search: '',
      pageTitle: '  Monstera\n deliciosa ',
      navigationType: 'REPLACE',
    });
    expect(update).toMatchObject({
      path: '/plants/p1',
      title: 'Monstera deliciosa',
      tab: 'plants',
      canGoBack: true,
      largeTitle: false,
      navigation: 'replace',
    });
    expect(update.rightButton).toBeUndefined();
  });

  it('keeps the query in the path: a settings section is its own screen', () => {
    const update = buildUpdate({
      ...base,
      pathname: '/settings',
      search: '?section=about',
      pageTitle: 'Settings',
      navigationType: 'POP',
    });
    expect(update).toMatchObject({
      path: '/settings?section=about',
      tab: 'more',
      navigation: 'pop',
    });
  });

  it('names a screen with no h1 after its More row, then its first h2', () => {
    const chat = buildUpdate({ ...base, pathname: '/chat', search: '', pageTitle: '' });
    expect(chat.title).toBe('nav.chat');
    const report = buildUpdate({
      ...base,
      pathname: '/household/caretaker-report',
      search: '',
      pageTitle: '',
      fallbackHeading: ' Caretaker visit report ',
    });
    expect(report.title).toBe('Caretaker visit report');
    const h1Wins = buildUpdate({
      ...base,
      pathname: '/chat',
      search: '',
      pageTitle: 'Plant care chat',
      fallbackHeading: 'Something else',
    });
    expect(h1Wins.title).toBe('Plant care chat');
  });

  it('hides the h1 only when the bar says the same words', () => {
    expect(sameTitle('Plants', ' plants ')).toBe(true);
    expect(sameTitle('Welcome back, Dana', 'Home')).toBe(false);
    expect(sameTitle('', '')).toBe(false);
  });
});

describe('the Swift side reads the same messages', () => {
  it('registers as NativeChrome with the frame calls and the alert calls', () => {
    expect(plugin).toMatch(/jsName = "NativeChrome"/);
    const methods = [...plugin.matchAll(/CAPPluginMethod\(name: "([^"]+)"/g)].map((m) => m[1]);
    // present, updatePresented and dismissPresented: nativePresent.test.ts.
    // setBarTools: nativeBarTools.test.ts.
    expect(methods.sort()).toEqual([
      'configure',
      'dismissPresented',
      'present',
      'setBarTools',
      'update',
      'updatePresented',
    ]);
    expect(main).toMatch(/registerPluginInstance\(nativeChrome\)/);
  });

  it('reads every update field the web sends, by the same name', () => {
    const update = buildUpdate({
      pathname: '/plants',
      search: '',
      key: 'k',
      navigationType: 'PUSH',
      pageTitle: 'Plants',
      session: { signedIn: true, hasHousehold: true },
      t,
    });
    const body = plugin.slice(
      plugin.indexOf('@objc func update('),
      plugin.indexOf('@objc func present(')
    );
    const read = new Set([...body.matchAll(/call\.get\w+\("([^"]+)"\)/g)].map((m) => m[1]));
    expect([...read].sort()).toEqual(Object.keys(update).sort());
    for (const field of ['id', 'symbol', 'label']) expect(body).toContain(`raw["${field}"]`);
  });

  it('reads every configure field the web sends', () => {
    const config = buildConfiguration(t, [{ householdId: 'a', name: 'A' }], 'a');
    const body = plugin.slice(
      plugin.indexOf('@objc func configure'),
      plugin.indexOf('@objc func update(')
    );
    for (const key of Object.keys(config)) expect(body, `configure.${key}`).toContain(`"${key}"`);
    for (const key of Object.keys(config.tabs[0]))
      expect(body, `tabs[].${key}`).toContain(`"${key}"`);
    const item = config.moreSections[0].items[0];
    for (const key of Object.keys(item)) expect(body, `items[].${key}`).toContain(`"${key}"`);
    for (const key of Object.keys(config.signOutConfirm)) expect(body).toContain(`"${key}"`);
  });

  it('sends exactly the events the web listens for, with the same fields', () => {
    const sent = [...plugin.matchAll(/notifyListeners\("([^"]+)", data: ([^\n]+)/g)];
    const events: Record<keyof (NativeChromeEvents & NativeBarToolsEvents), string[]> = {
      tabSelect: ['tab', 'path', 'reselect'],
      back: ['path'],
      moreSelect: [],
      rightButton: ['id'],
      barMenuSelect: ['path', 'id'],
      barSearch: ['path', 'text'],
    };
    expect(sent.map((m) => m[1]).sort()).toEqual(Object.keys(events).sort());
    for (const [name, fields] of Object.entries(events)) {
      const line = sent.find((m) => m[1] === name)![2];
      for (const field of fields) expect(line, `${name}.${field}`).toContain(`"${field}"`);
    }
    expect(plugin).toContain('var data: [String: Any] = ["id": id]');
    expect(plugin).toContain('data["path"] = path');
  });
});

describe('hasNativeFrame / markNativeFrame', () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    delete document.documentElement.dataset.nativeFrame;
  });

  const shell = (platform: string, plugins: string[]) => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      PluginHeaders: plugins.map((name) => ({ name, methods: [] })),
    };
  };

  it('marks <html data-native-frame> in the iOS app when the plugin is registered', () => {
    shell('ios', ['Print', 'NativeChrome']);
    expect(hasNativeFrame()).toBe(true);
    markNativeFrame();
    expect(document.documentElement.hasAttribute('data-native-frame')).toBe(true);
  });

  it('never on the website, on Android, or in an iOS build without the plugin', () => {
    markNativeFrame();
    expect(document.documentElement.hasAttribute('data-native-frame')).toBe(false);
    shell('android', ['NativeChrome']);
    markNativeFrame();
    expect(document.documentElement.hasAttribute('data-native-frame')).toBe(false);
    shell('ios', ['Print']);
    markNativeFrame();
    expect(document.documentElement.hasAttribute('data-native-frame')).toBe(false);
  });
});

describe('Settings as a native list on More', () => {
  const config = buildConfiguration(t, [], null);
  const rows = config.settings.sections.flatMap((s) => s.items);

  it("More's Settings row opens the native list, by the path Swift knows", () => {
    const row = config.moreSections.flatMap((s) => s.items).find((i) => i.id === 'settings');
    expect(row?.path).toBe(SETTINGS_LIST_PATH);
    expect(controller).toContain(
      'static let settingsListPath = "\\(FrameEntry.nativeListPrefix)settings"'
    );
    expect(model).toContain('static let nativeListPrefix = "native:"');
    expect(SETTINGS_LIST_PATH).toBe('native:settings');
  });

  it('lists every section the app has, once, each opening its own page', () => {
    expect(config.settings.title).toBe('nav.settings');
    const listed = SETTINGS_LIST_GROUPS.flat().map((r) => r.section);
    expect([...listed].sort()).toEqual([...NATIVE_SETTINGS_SECTIONS].sort());
    for (const section of NATIVE_SETTINGS_SECTIONS) {
      const row = rows.find((r) => r.id === `${SETTINGS_ROW_PREFIX}${section}`);
      expect(row, section).toBeDefined();
      expect(row!.path).toBe(settingsSectionPath(section));
      expect(row!.path!.startsWith('/settings')).toBe(true);
      expect(row!.symbol, section).toMatch(/\S/);
      expect(row!.destructive ?? false).toBe(false);
    }
    // Plan status keeps its own route; About is last, as #903 built it.
    expect(settingsSectionPath('billing')).toBe('/settings/billing');
    expect(SETTINGS_LIST_GROUPS.at(-1)!.map((r) => r.section)).toEqual(['about']);
  });

  it('Swift reads the settings list by the same names', () => {
    const body = plugin.slice(
      plugin.indexOf('@objc func configure'),
      plugin.indexOf('@objc func update(')
    );
    expect(body).toContain('call.getObject("settings")');
    for (const key of Object.keys(config.settings)) expect(body).toContain(`settings["${key}"]`);
  });
});

describe('nativeSwitchRole', () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('is a switch inside the frame, and nothing on the website, on Android or without the frame', () => {
    expect(nativeSwitchRole()).toEqual({});
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      PluginHeaders: [{ name: 'NativeChrome', methods: [] }],
    };
    expect(nativeSwitchRole()).toEqual({});
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      PluginHeaders: [],
    };
    expect(nativeSwitchRole()).toEqual({});
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      PluginHeaders: [{ name: 'NativeChrome', methods: [] }],
    };
    expect(nativeSwitchRole()).toEqual({ role: 'switch' });
  });
});
