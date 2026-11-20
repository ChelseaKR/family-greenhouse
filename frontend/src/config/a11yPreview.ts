/**
 * A preview flag for the accessibility options from the 2026-11 conformance
 * report that are waiting on a design choice (ACR rows 1.4.1 and 1.4.11, and
 * Appendix C's 2.5.7). Unset, nothing changes: the selected view toggles and
 * filter chips look as they always have, and tapping the current tab in the
 * iOS app does what it always did.
 *
 * Set it to one of the selected-state styles to try that style (and, in the
 * native shells, the tap-the-tab-again refresh):
 *
 * - `edge`: the selected chip or segment gets a 2 px `primary-700` edge.
 * - `check`: the same edge, and a check mark before a selected chip's label.
 * - `fill`: the selected chip or segment is filled `primary-700` with white
 *   text, as the plant-name and billing-interval choices already are.
 *
 * Two ways to set it, neither of which reaches a production visitor:
 * `VITE_A11Y_PREVIEW=fill` at build time (for a simulator build), or, in the
 * Vite dev server only, `localStorage['fg.a11yPreview'] = 'fill'` and reload.
 *
 * The styles are CSS keyed on `html[data-selected-style]` (index.css); the
 * check mark is a CSS mask with empty generated content, so no element and
 * no accessible name is added. Each control keeps its `aria-pressed`.
 */
export const A11Y_PREVIEW_STORAGE_KEY = 'fg.a11yPreview';

export const SELECTED_STATE_STYLES = ['edge', 'check', 'fill'] as const;
export type SelectedStateStyle = (typeof SELECTED_STATE_STYLES)[number];

function isStyle(value: unknown): value is SelectedStateStyle {
  return (SELECTED_STATE_STYLES as readonly unknown[]).includes(value);
}

export function readA11yPreview(
  env: { DEV?: boolean; VITE_A11Y_PREVIEW?: string } = import.meta.env,
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): SelectedStateStyle | null {
  if (env.DEV && storage) {
    try {
      const stored = storage.getItem(A11Y_PREVIEW_STORAGE_KEY);
      if (isStyle(stored)) return stored;
    } catch {
      // Blocked storage: fall through to the build-time value.
    }
  }
  return isStyle(env.VITE_A11Y_PREVIEW) ? env.VITE_A11Y_PREVIEW : null;
}

/** Marks `<html>` with the chosen style; leaves it untouched when unset. */
export function applyA11yPreview(root: HTMLElement = document.documentElement): void {
  const style = readA11yPreview();
  if (style) root.dataset.selectedStyle = style;
}

/** The tap-the-current-tab-again refresh (iOS, WCAG 2.5.7) is on. */
export function isTabRetapRefreshPreview(): boolean {
  return readA11yPreview() !== null;
}
