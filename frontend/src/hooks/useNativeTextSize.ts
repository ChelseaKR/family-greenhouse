import { useEffect } from 'react';
import { getNativePlatform } from '@/lib/platform';

/**
 * The text scale to apply for the size iOS reports: exactly that size, with
 * no ceiling, so the app follows every setting the person chose, including
 * the accessibility sizes past 300%. Only a value that cannot be a size
 * (NaN, zero, negative) falls back to the default.
 *
 * There used to be a 200% cap here, on the theory that fixed-height controls
 * clip their labels past it. The owner decision (2026-09-18) is that the fix
 * for a layout that clips at a large size is the layout — wrapping, or
 * scrolling — never a smaller size than the person asked for. The layout is
 * checked at the largest iOS size (AX5, about 312%) by
 * tests/e2e/largest-text.spec.ts.
 */
export function textScaleFor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

/**
 * From here up the layout uses its large-text arrangement: iOS's
 * accessibility sizes start at AX1, 28pt body text over 17pt (about 165%);
 * the largest standard size, XXXL, is 23pt (about 135%).
 */
export const LARGE_TEXT_SCALE = 1.5;

/**
 * Mark `<html data-text-size="large">` at the accessibility sizes, and clear
 * it below them. index.css keys the `large-text:` variant and its wrapping
 * rules on this attribute.
 */
export function markTextScale(scale: number, root: HTMLElement = document.documentElement): void {
  if (scale >= LARGE_TEXT_SCALE) root.dataset.textSize = 'large';
  else delete root.dataset.textSize;
}

/**
 * iOS Dynamic Type inside the shell.
 *
 * WKWebView ignores the iOS text size setting: a person who has set larger
 * text in Settings > Accessibility > Display & Text Size got the same 16px
 * body text as everyone else, in an app where every other screen on the
 * phone honored it. `@capacitor/text-zoom` reads the preferred size (the body
 * text style's point size over the default 17pt) and applies it as the
 * page's text-size adjustment, all the way up. Smaller settings are honored
 * too. It is
 * applied on launch and again whenever the app comes back to the foreground,
 * so a change made in Settings takes effect on return.
 *
 * Android needs nothing: its WebView already scales text with the system font
 * size. iOS only, and the plugin is imported dynamically after the platform
 * check, so web visitors never download it.
 */
export function useNativeTextSize(): void {
  useEffect(() => {
    if (getNativePlatform() !== 'ios') return;

    const apply = () =>
      import('@capacitor/text-zoom')
        .then(async ({ TextZoom }) => {
          const { value } = await TextZoom.getPreferred();
          const scale = textScaleFor(value);
          await TextZoom.set({ value: scale });
          markTextScale(scale);
        })
        .catch(() => undefined);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void apply();
    };

    void apply();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}
