import {
  NATIVE_SETTINGS_SECTIONS,
  SETTINGS_SECTION_LABEL,
  settingsSectionPath,
  type SettingsSection,
} from '@/features/settings/settingsSections';

/**
 * The iOS app's native frame: which tab each route belongs to, and the
 * messages the web and Swift send each other through the NativeChrome plugin.
 *
 * The frame is Apple's own UITabBar and UINavigationBar, drawn by Swift
 * (ios/App/App/NativeFrame*.swift) around the ONE web view the app has. Swift
 * owns the bars and each tab's back stack; the web owns everything inside the
 * page, and this file is the single source for what the bars say:
 *
 * - `configure` (web -> native, at launch and when the language or the
 *   household list changes): the five tabs with their labels and SF Symbols,
 *   and the rows of the More list.
 * - `update` (web -> native, on every route change and when the page's title
 *   changes): a NativeChromeUpdate.
 * - Events (native -> web): `tabSelect`, `back` and `moreSelect` (each with the
 *   route the web should show; the web navigates there) and `rightButton`.
 *
 * Every route in App.tsx is either mapped to a tab here or deliberately left
 * unmapped; tests/unit/config/nativeFrame.test.ts fails on a route nobody
 * decided about.
 */

export type NativeTabId = 'home' | 'plants' | 'tasks' | 'household' | 'more';

export interface NativeTabDefinition {
  id: NativeTabId;
  /** The route the tab opens on. `null` for More: its root is a native list. */
  root: string | null;
  labelKey: string;
  /** SF Symbol, and its filled form for the selected tab. */
  symbol: string;
  selectedSymbol: string;
}

/** Home, Plants, Tasks, Household, More (owner decision 2026-10-02). */
export const NATIVE_TABS: readonly NativeTabDefinition[] = [
  {
    id: 'home',
    root: '/dashboard',
    labelKey: 'nav.home',
    symbol: 'house',
    selectedSymbol: 'house.fill',
  },
  {
    id: 'plants',
    root: '/plants',
    labelKey: 'nav.plants',
    symbol: 'leaf',
    selectedSymbol: 'leaf.fill',
  },
  {
    id: 'tasks',
    root: '/tasks',
    labelKey: 'nav.tasks',
    symbol: 'checkmark.circle',
    selectedSymbol: 'checkmark.circle.fill',
  },
  {
    id: 'household',
    root: '/household',
    labelKey: 'nav.household',
    symbol: 'person.2',
    selectedSymbol: 'person.2.fill',
  },
  {
    id: 'more',
    root: null,
    labelKey: 'nav.more',
    symbol: 'ellipsis.circle',
    selectedSymbol: 'ellipsis.circle.fill',
  },
];

/**
 * Route -> tab, by path prefix. A prefix `/plants` matches `/plants` and
 * `/plants/...`, never `/plantsfoo`. Order matters only for readability: no
 * two prefixes overlap.
 */
const TAB_PREFIXES: ReadonlyArray<readonly [string, NativeTabId]> = [
  ['/dashboard', 'home'],
  ['/plants', 'plants'],
  ['/tags', 'plants'],
  ['/shared', 'plants'],
  ['/tasks', 'tasks'],
  ['/household', 'household'],
  ['/away-recap', 'household'],
  ['/join', 'household'],
  // Everything the drawer held that is not a tab, and what those pages link to.
  ['/today', 'more'],
  ['/chat', 'more'],
  ['/analytics', 'more'],
  ['/settings', 'more'],
  ['/account', 'more'],
  ['/help', 'more'],
  ['/pricing', 'more'],
  ['/gift', 'more'],
  ['/changelog', 'more'],
  ['/support', 'more'],
  ['/status', 'more'],
  ['/legal', 'more'],
];

/**
 * Routes that belong to no tab, on purpose: the marketing and reading pages
 * (reached in the app only by a link inside a page), and the public token
 * pages for people without an account. Opened inside the app, they stay in
 * the tab they were opened from.
 */
export const UNMAPPED_PREFIXES: readonly string[] = [
  '/blog',
  '/care',
  '/pet-safe',
  '/sit',
  '/tag',
  '/caretaker',
  '/account-deletion',
];

/**
 * Sign-in and first-run setup: no tab bar and no navigation bar, the screen
 * is the whole screen. The same list as BackSwipePolicy.signInAndSetupPaths
 * in MainViewController.swift (the contract test holds the two together).
 */
export const SIGN_IN_AND_SETUP_PATHS: readonly string[] = [
  '/login',
  '/register',
  '/confirm-email',
  '/forgot-password',
  '/reset-password',
  '/onboarding',
  '/welcome',
];

function normalize(pathname: string): string {
  if (!pathname) return '/';
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The tab a route belongs to, or null (it stays in whichever tab it opened in). */
export function tabForPath(pathname: string): NativeTabId | null {
  const path = normalize(pathname);
  for (const [prefix, tab] of TAB_PREFIXES) {
    if (under(path, prefix)) return tab;
  }
  return null;
}

/** A tab's own first screen: large title, no back button. */
export function isTabRoot(pathname: string): boolean {
  const path = normalize(pathname);
  return NATIVE_TABS.some((tab) => tab.root === path);
}

export function tabDefinition(id: NativeTabId): NativeTabDefinition {
  return NATIVE_TABS.find((tab) => tab.id === id)!;
}

export type NativeChromeMode = 'tabs' | 'none';

/**
 * Whether the native bars show at all. Not on sign-in or setup, not before
 * there is a household to show, not on `/` (it only redirects), and not on
 * the household wall display, which has no way off it by design.
 */
export function chromeForPath(
  pathname: string,
  session: { signedIn: boolean; hasHousehold: boolean }
): NativeChromeMode {
  const path = normalize(pathname);
  if (!session.signedIn || !session.hasHousehold) return 'none';
  if (path === '/' || under(path, '/kiosk')) return 'none';
  if (SIGN_IN_AND_SETUP_PATHS.some((p) => under(path, p))) return 'none';
  return 'tabs';
}

/** A trailing navigation-bar button a screen asks for. */
export interface NativeBarButton {
  /** Sent back in the `rightButton` event. */
  id: string;
  /** SF Symbol for the button. */
  symbol: string;
  /** Its VoiceOver label (the symbol alone has none). */
  label: string;
}

/** What the web tells the frame on every route change (`update`). */
export interface NativeChromeUpdate {
  /** pathname + search: the identity of a screen in a tab's back stack. */
  path: string;
  /** React Router's location key: a new key is a new screen, even on the same path. */
  key: string;
  /** The navigation bar title. Empty until the page has one. */
  title: string;
  /** The route's tab; null keeps the tab it was opened from. */
  tab: NativeTabId | null;
  /** True when the route has a screen to go back to inside its tab. */
  canGoBack: boolean;
  /** Large title: a tab's first screen. */
  largeTitle: boolean;
  chrome: NativeChromeMode;
  /** How the web got here: a new screen, a replaced one, or browser back. */
  navigation: 'push' | 'replace' | 'pop';
  rightButton?: NativeBarButton;
}

/** One row of the native More list. */
export interface NativeMoreItem {
  /** Sent back in the `moreSelect` event. */
  id: string;
  title: string;
  /** SF Symbol shown at the start of the row. */
  symbol?: string;
  /** The route the web opens when the row is chosen. */
  path?: string;
  /** Shown with a checkmark (the active household). */
  checked?: boolean;
  /** Red, and confirmed with an action sheet first (sign out). */
  destructive?: boolean;
}

export interface NativeMoreSection {
  title?: string;
  items: NativeMoreItem[];
}

export interface NativeChromeConfiguration {
  tabs: Array<{
    id: NativeTabId;
    title: string;
    symbol: string;
    selectedSymbol: string;
    root: string | null;
  }>;
  moreTitle: string;
  moreSections: NativeMoreSection[];
  /** The sign-out action sheet. */
  signOutConfirm: { title: string; confirm: string; cancel: string };
  /**
   * Settings as a native list, pushed on More by its Settings row (whose
   * path is SETTINGS_LIST_PATH). Each row opens that section's web page.
   */
  settings: { title: string; sections: NativeMoreSection[] };
}

/** Native -> web events, by name. */
export interface NativeChromeEvents {
  /** A tab was chosen (or the current one again: `reselect`). Show `path`. */
  tabSelect: { tab: NativeTabId; path: string | null; reselect: boolean };
  /** The back button or the edge swipe popped a screen. Show `path`. */
  back: { path: string };
  /** A row of the More list. Open `path`, or act on `id`. */
  moreSelect: { id: string; path?: string };
  rightButton: { id: string };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The drawer's destinations that are not tabs, in its order, plus About. */
export const MORE_DESTINATIONS: ReadonlyArray<{
  id: string;
  path: string;
  labelKey: string;
  symbol: string;
}> = [
  { id: 'today', path: '/today', labelKey: 'nav.today', symbol: 'sun.max' },
  { id: 'chat', path: '/chat', labelKey: 'nav.chat', symbol: 'bubble.left.and.bubble.right' },
  { id: 'analytics', path: '/analytics', labelKey: 'nav.analytics', symbol: 'chart.bar' },
  // Opens the native Settings list (below), not a web page.
  { id: 'settings', path: 'native:settings', labelKey: 'nav.settings', symbol: 'gearshape' },
];

export const MORE_SUPPORT: ReadonlyArray<{
  id: string;
  path: string;
  labelKey: string;
  symbol: string;
}> = [
  { id: 'help', path: '/help', labelKey: 'nav.help', symbol: 'questionmark.circle' },
  // Settings -> About holds the memorial line in the apps (owner decision
  // 2026-10-02); the section is `?section=about`.
  { id: 'about', path: '/settings?section=about', labelKey: 'nav.about', symbol: 'info.circle' },
];

/** A More row with this path opens Settings' native list (NativeFrameController.settingsListPath). */
export const SETTINGS_LIST_PATH = 'native:settings';

/**
 * Settings' native list: every section the app's Settings page has, grouped
 * as in iOS's own Settings, each with an SF Symbol. Plan status shows the
 * plan only (no prices, no purchase path; guideline 3.1.1), as #903 built it.
 */
export const SETTINGS_LIST_GROUPS: ReadonlyArray<
  ReadonlyArray<{ section: SettingsSection; symbol: string }>
> = [
  [
    { section: 'preferences', symbol: 'slider.horizontal.3' },
    { section: 'notifications', symbol: 'bell' },
  ],
  [
    { section: 'billing', symbol: 'leaf' },
    { section: 'refer', symbol: 'person.badge.plus' },
    { section: 'plant-tags', symbol: 'tag' },
    { section: 'kiosk', symbol: 'display' },
    { section: 'api-keys', symbol: 'key' },
  ],
  [
    { section: 'trash', symbol: 'trash' },
    { section: 'security', symbol: 'lock' },
    { section: 'account', symbol: 'person.crop.circle' },
  ],
  [{ section: 'about', symbol: 'info.circle' }],
];

export const SETTINGS_ROW_PREFIX = 'settings:';

export function buildSettingsSections(t: Translate): NativeMoreSection[] {
  return SETTINGS_LIST_GROUPS.map((group) => ({
    items: group
      .filter(({ section }) => NATIVE_SETTINGS_SECTIONS.includes(section))
      .map(({ section, symbol }) => ({
        id: `${SETTINGS_ROW_PREFIX}${section}`,
        title: t(SETTINGS_SECTION_LABEL[section]),
        symbol,
        path: settingsSectionPath(section),
      })),
  }));
}

export const SIGN_OUT_ID = 'signOut';
export const ADD_HOUSEHOLD_ID = 'addHousehold';
export const HOUSEHOLD_ID_PREFIX = 'household:';

export function buildConfiguration(
  t: Translate,
  households: ReadonlyArray<{ householdId: string; name: string }>,
  activeHouseholdId: string | null
): NativeChromeConfiguration {
  const sections: NativeMoreSection[] = [];
  if (households.length > 0) {
    sections.push({
      title: t('nav.households'),
      items: [
        ...households.map((h) => ({
          id: `${HOUSEHOLD_ID_PREFIX}${h.householdId}`,
          title: h.name,
          symbol: 'house',
          checked: h.householdId === activeHouseholdId,
        })),
        {
          id: ADD_HOUSEHOLD_ID,
          title: t('nav.addHousehold'),
          symbol: 'plus',
          path: '/onboarding?mode=add',
        },
      ],
    });
  }
  sections.push({
    items: MORE_DESTINATIONS.map((d) => ({
      id: d.id,
      title: t(d.labelKey),
      symbol: d.symbol,
      path: d.path,
    })),
  });
  sections.push({
    items: MORE_SUPPORT.map((d) => ({
      id: d.id,
      title: t(d.labelKey),
      symbol: d.symbol,
      path: d.path,
    })),
  });
  sections.push({ items: [{ id: SIGN_OUT_ID, title: t('nav.signOut'), destructive: true }] });

  return {
    tabs: NATIVE_TABS.map((tab) => ({
      id: tab.id,
      title: t(tab.labelKey),
      symbol: tab.symbol,
      selectedSymbol: tab.selectedSymbol,
      root: tab.root,
    })),
    moreTitle: t('nav.more'),
    moreSections: sections,
    signOutConfirm: {
      title: t('nav.signOutConfirm'),
      confirm: t('nav.signOut'),
      cancel: t('common.cancel'),
    },
    settings: { title: t('nav.settings'), sections: buildSettingsSections(t) },
  };
}

/**
 * The bar title for a route before (or instead of) the page's own h1: a
 * tab's first screen is called what its tab is called, as in iOS's own apps.
 * Every other screen takes its h1 (`pageTitle`).
 */
export function titleFor(pathname: string, pageTitle: string, t: Translate): string {
  const path = normalize(pathname);
  const tab = NATIVE_TABS.find((d) => d.root !== null && d.root === path);
  if (tab) return t(tab.labelKey);
  return pageTitle.trim().replace(/\s+/g, ' ');
}

/** Screens that ask for a trailing bar button. */
export function rightButtonFor(pathname: string, t: Translate): NativeBarButton | undefined {
  if (normalize(pathname) === '/plants') {
    return { id: 'addPlant', symbol: 'plus', label: t('plants.addPlant') };
  }
  return undefined;
}

/** What the `rightButton` event with this id opens. */
export const RIGHT_BUTTON_PATHS: Readonly<Record<string, string>> = {
  addPlant: '/plants/new',
};

/**
 * A route's own name, for a screen whose page has no h1 (the locked Chat
 * page, the caretaker report): what the More row that opens it is called.
 */
export function labelForPath(pathname: string, t: Translate): string {
  const path = normalize(pathname);
  const row = [...MORE_DESTINATIONS, ...MORE_SUPPORT].find((d) => d.path === path);
  return row ? t(row.labelKey) : '';
}

export function buildUpdate(input: {
  pathname: string;
  search: string;
  key: string;
  navigationType: 'PUSH' | 'REPLACE' | 'POP';
  pageTitle: string;
  /** The page's first h2, for a page with no h1 and no label of its own. */
  fallbackHeading?: string;
  session: { signedIn: boolean; hasHousehold: boolean };
  t: Translate;
}): NativeChromeUpdate {
  const { pathname, search, key, navigationType, pageTitle, session, t } = input;
  const clean = (text: string) => text.trim().replace(/\s+/g, ' ');
  const screenTitle =
    clean(pageTitle) || labelForPath(pathname, t) || clean(input.fallbackHeading ?? '');
  const tab = tabForPath(pathname);
  const root = isTabRoot(pathname) && !search;
  const update: NativeChromeUpdate = {
    path: `${normalize(pathname)}${search}`,
    key,
    title: root ? titleFor(pathname, pageTitle, t) : screenTitle,
    tab,
    canGoBack: !root,
    largeTitle: root,
    chrome: chromeForPath(pathname, session),
    navigation:
      navigationType === 'PUSH' ? 'push' : navigationType === 'REPLACE' ? 'replace' : 'pop',
  };
  const rightButton = root ? rightButtonFor(pathname, t) : undefined;
  if (rightButton) update.rightButton = rightButton;
  return update;
}

/** Same words, ignoring case and spacing: then the h1 is visually hidden. */
export function sameTitle(a: string, b: string): boolean {
  const clean = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return clean(a) !== '' && clean(a) === clean(b);
}
