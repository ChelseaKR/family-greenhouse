/**
 * "This page is being left", for telling a chunk that failed to load apart
 * from one whose download was cancelled because the person navigated away.
 *
 * Safari (WebKit) reports a dynamic import cut short by a full-page
 * navigation as "Importing a module script failed", on the page being left.
 * The route boundary then reported "We couldn't load this page" to telemetry
 * and logged it, for a page nobody would see again: every quick tap away from
 * a page still fetching its code in Safari counted as an app failure.
 * Chromium cancels the same import silently.
 *
 * `beforeunload` marks the leaving before the browser cancels anything, and
 * `pagehide` covers a page that leaves without it. A page restored from the
 * back/forward cache is not leaving any more, and a mark that is a few seconds
 * old means the navigation never happened (a `mailto:` link fires
 * `beforeunload` and stays put), so real failures after it still count.
 */
const STALE_AFTER_MS = 5_000;
let leavingSince: number | null = null;

export function watchPageLeaving(target: Window = window): void {
  const mark = () => {
    leavingSince = Date.now();
  };
  target.addEventListener('beforeunload', mark);
  target.addEventListener('pagehide', mark);
  target.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) leavingSince = null;
  });
}

export function isPageLeaving(now: number = Date.now()): boolean {
  return leavingSince !== null && now - leavingSince < STALE_AFTER_MS;
}

const CHUNK_LOAD =
  /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return CHUNK_LOAD.test(message);
}

/** A chunk load that failed only because the page is being left. */
export function isAbandonedChunkLoad(error: unknown): boolean {
  return isChunkLoadError(error) && isPageLeaving();
}

/** For tests: forget any earlier leaving. */
export function resetPageLeavingForTests(): void {
  leavingSince = null;
}
