import type { MenuGroupModel } from '@/features/plants/ToolbarMenu';

/**
 * A screen's own tools in the iOS app's navigation bar (NativeChrome
 * `setBarTools`, ios/App/App/NativeBarTools.swift): pull-down menus beside
 * the "+" and a search field that the bar reveals when the list is pulled
 * down. The web owns the words and the choices; Swift only draws them and
 * reports what was picked or typed.
 *
 * Tools belong to one route (`path`). Each send replaces that route's tools;
 * an empty `menus` with `search: null` removes them.
 */
export interface NativeBarMenu {
  /** Stable id, also the menu's accessibility identifier. */
  id: string;
  /** What VoiceOver says for the bar button. */
  label: string;
  /** SF Symbol for the bar button. */
  symbol: string;
  /** Inline sections; an item with `checked` is a pick-one option. */
  groups: MenuGroupModel[];
}

export interface NativeBarTools {
  path: string;
  menus: NativeBarMenu[];
  search: { placeholder: string; text: string } | null;
}

export interface NativeBarToolsEvents {
  /** A menu item was picked: the `id` of the item, as sent. */
  barMenuSelect: { path: string; id: string };
  /** The bar's search field changed (every keystroke, and '' on Cancel). */
  barSearch: { path: string; text: string };
}
