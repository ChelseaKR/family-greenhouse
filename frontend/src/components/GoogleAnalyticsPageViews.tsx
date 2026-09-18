import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { trackGooglePageView } from '@/services/googleAnalytics';

/**
 * One GA4 page view per route change — the SPA half of
 * services/googleAnalytics.ts, which does nothing unless GA loaded at boot.
 *
 * Explicit rather than left to GA's enhanced measurement, because that reads
 * the raw address (tokens, record ids, every query parameter) and the raw
 * document title (a plant's name); `trackGooglePageView` sends scrubbed ones.
 * Keyed on path + query only, so a fragment change (the skip link) is not a
 * page view.
 *
 * Rendered after the routed content in App, so in the commit that shows a new
 * page this effect runs after that page's own effects — the document title it
 * reads is the new page's, not the old one's. Renders nothing.
 */
export function GoogleAnalyticsPageViews(): null {
  const { pathname, search } = useLocation();
  useEffect(() => {
    trackGooglePageView(pathname, search);
  }, [pathname, search]);
  return null;
}
