/**
 * The canonical production origin — the single source of truth for absolute
 * URLs in SEO surfaces (canonical links, JSON-LD `@id`, Open Graph image URLs).
 *
 * Previously each page hardcoded `https://app.familygreenhouse.com`, which
 * drifted from the live domain (`familygreenhouse.net`) and silently pointed
 * every sitemap entry, canonical signal, and structured-data URL at a host that
 * doesn't resolve — telling Google the "real" version of each page lived on a
 * dead domain. One constant keeps that from happening again. The two static
 * SEO assets that can't import this (`public/robots.txt`, `public/sitemap.xml`)
 * must use the same value.
 */
export const SITE_URL = 'https://familygreenhouse.net';

/** Build an absolute site URL from a root-relative path (e.g. `/care/pothos`). */
export function siteUrl(path = '/'): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The iOS app's App Store Connect id, and its "write a review" page. Settings
 * → About's "Rate Family Greenhouse" row opens it, inside the iOS app only
 * (ADR 0036): the shell hands an outside link to iOS, which opens the App
 * Store app on the review form.
 */
export const APP_STORE_APP_ID = '6812185914';
export const APP_STORE_WRITE_REVIEW_URL = `https://apps.apple.com/app/id${APP_STORE_APP_ID}?action=write-review`;
