/**
 * Settings' sections: their ids, labels and routes. One list for the web
 * page (SettingsPage.tsx: the tabs and, on a phone, the section picker) and
 * for the iOS app's native Settings list (config/nativeFrame.ts), so the two
 * cannot drift.
 */

export type SettingsSection =
  | 'preferences'
  | 'notifications'
  | 'plant-tags'
  | 'billing'
  | 'refer'
  | 'kiosk'
  | 'api-keys'
  | 'trash'
  | 'security'
  | 'account'
  | 'about';

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'preferences',
  'notifications',
  'plant-tags',
  'billing',
  'refer',
  'kiosk',
  'api-keys',
  'trash',
  // Security sits before Account so Account stays the last tab (End key).
  'security',
  'account',
];

/**
 * The apps add About, last: it holds the memorial line, which in the apps
 * lives there and nowhere else (owner decision 2026-10-02). The website has
 * no About section; its pages close with the line instead.
 */
export const NATIVE_SETTINGS_SECTIONS: readonly SettingsSection[] = [...SETTINGS_SECTIONS, 'about'];

export const SETTINGS_SECTION_LABEL: Record<SettingsSection, string> = {
  preferences: 'settings.tabs.preferences',
  notifications: 'settings.tabs.notifications',
  'plant-tags': 'settings.tabs.plantTags',
  billing: 'settings.tabs.billing',
  refer: 'settings.tabs.refer',
  kiosk: 'settings.tabs.kiosk',
  'api-keys': 'settings.tabs.apiKeys',
  trash: 'settings.tabs.trash',
  account: 'settings.tabs.account',
  security: 'settings.tabs.security',
  about: 'settings.tabs.about',
};

/** Where a section lives: Plan status has its own route; Preferences is the default. */
export function settingsSectionPath(section: SettingsSection): string {
  if (section === 'billing') return '/settings/billing';
  return section === 'preferences' ? '/settings' : `/settings?section=${section}`;
}
