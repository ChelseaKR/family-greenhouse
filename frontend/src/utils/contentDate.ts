/**
 * Render a `YYYY-MM-DD` content date as prose without shifting it.
 *
 * A content date is a calendar day, not an instant: `date: '2026-09-02'` in
 * a manifest means the 2nd, in every zone. But `new Date('2026-09-02')`
 * parses a date-only string as UTC midnight, and `toLocaleDateString` then
 * renders that instant in the host's zone — 20:00 on the 1st anywhere in
 * the US. So the same literal printed "September 2" in the prerender (built
 * in UTC) and "September 1" after hydration in a US browser, one day behind
 * the `datePublished` and `article:published_time` in the same document.
 *
 * Both the parse and the format state UTC, so the answer is the literal's
 * own day everywhere. The locale is fixed too: the public pages ship in
 * English (`<html lang="en">`, `og:locale` en_US), and a browser-locale
 * render would differ from the prerendered text for every non-US reader —
 * "2 September 2026" hydrating over "September 2, 2026".
 *
 * Not in `utils/date.ts` on purpose. Everything there reads an INSTANT in
 * the browser's zone, and its closing note explains why no zone-aware day
 * helper lives there until ADR 0025 phase 6 settles the household's zone.
 * This is the other case — a literal with no instant behind it — so the
 * zone is stated at the call site, which is what that note asks for.
 */
export type ContentDateStyle = 'long' | 'short' | 'month';

const STYLES: Record<ContentDateStyle, Intl.DateTimeFormatOptions> = {
  /** "September 5, 2026" */
  long: { year: 'numeric', month: 'long', day: 'numeric' },
  /** "Sep 5" */
  short: { month: 'short', day: 'numeric' },
  /** "September 2026" */
  month: { year: 'numeric', month: 'long' },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function formatContentDate(iso: string, style: ContentDateStyle = 'long'): string {
  // A timestamp here would be a different question (which zone's day?), and
  // the manifests only ever carry the date-only form — the registry tests
  // hold them to it. Refusing anything else keeps that true at the one place
  // a wrong shape would otherwise render as a plausible, wrong day.
  if (!ISO_DATE.test(iso)) {
    throw new Error(`formatContentDate: expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  }
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    ...STYLES[style],
    timeZone: 'UTC',
  });
}
