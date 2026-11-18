import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';

/** Marks the lazy-route spinner, so the announcer can wait for the page behind it. */
export const ROUTE_LOADING_ATTRIBUTE = 'data-route-loading';

const POLL_MS = 100;
/** A chunk that has not arrived by now is not going to name the page. */
const GIVE_UP_MS = 8000;

/**
 * Says the new page's title when the route changes.
 *
 * A browser announces a page when it loads one. This app loads once and then
 * swaps the view in place, so after the first page nothing told a screen-reader
 * user that choosing "Plants" had done anything: focus stays on the link, the
 * title changes silently, and the content they came for is somewhere else in
 * the document (WCAG 4.1.3; 2.4.2 is met only for those who can see the tab).
 *
 * The words are the document title the page already sets, so there is no new
 * copy here. Every page sets it in an effect, and child effects run before this
 * one, so the title is current by the time this reads it. The exception is a
 * lazy route whose chunk is still on its way: the spinner is on screen and the
 * title is still the old one, so wait for the spinner to go.
 *
 * Only the path is watched. A changed query string or hash (a Settings section,
 * a filter, an in-page anchor) is the same page.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [message, setMessage] = useState('');
  const isFirstPage = useRef(true);

  useEffect(() => {
    // The first page is announced by the browser itself.
    if (isFirstPage.current) {
      isFirstPage.current = false;
      return;
    }
    const started = Date.now();
    let timer = 0;
    const announce = () => {
      const stillLoading = document.querySelector(`[${ROUTE_LOADING_ATTRIBUTE}]`) !== null;
      if (stillLoading && Date.now() - started < GIVE_UP_MS) {
        timer = window.setTimeout(announce, POLL_MS);
        return;
      }
      setMessage(document.title);
    };
    timer = window.setTimeout(announce, 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return (
    <p className="sr-only" role="status" aria-atomic="true">
      {message}
    </p>
  );
}
