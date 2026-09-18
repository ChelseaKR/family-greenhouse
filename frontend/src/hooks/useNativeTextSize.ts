import { useEffect } from 'react';
import { getNativePlatform } from '@/lib/platform';

/**
 * The largest text size applied, as a multiple of the default. WCAG 1.4.4
 * asks for 200%, and the layout is built and tested to hold there. iOS's
 * accessibility sizes go past 300%, where fixed-height controls in a web
 * layout start clipping their own labels, so the scale stops at 200%.
 */
export const MAX_TEXT_SCALE = 2;

export function clampTextScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(value, MAX_TEXT_SCALE);
}

/**
 * iOS Dynamic Type inside the shell.
 *
 * WKWebView ignores the iOS text size setting: a person who has set larger
 * text in Settings > Accessibility > Display & Text Size got the same 16px
 * body text as everyone else, in an app where every other screen on the
 * phone honored it. `@capacitor/text-zoom` reads the preferred size (the body
 * text style's point size over the default 17pt) and applies it as the
 * page's text-size adjustment. Smaller settings are honored too. It is
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
          await TextZoom.set({ value: clampTextScale(value) });
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
