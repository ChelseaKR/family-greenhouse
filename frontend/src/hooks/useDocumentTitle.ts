import { useEffect } from 'react';

const SUFFIX = ' • Family Greenhouse';

/**
 * Set `document.title` to the given page title plus a suffix, restoring the
 * suffix-only title on unmount. Closes WCAG 2.4.2 (Page Titled) for SPA
 * routes where the static `<title>` in `index.html` would otherwise lie
 * about which page the user is on.
 */
export function useDocumentTitle(pageTitle: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = pageTitle ? `${pageTitle}${SUFFIX}` : `Family Greenhouse`;
    return () => {
      document.title = previous;
    };
  }, [pageTitle]);
}
