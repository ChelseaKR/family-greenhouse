/**
 * The navigations the service worker must NOT answer with the SPA shell.
 *
 * vite.config.ts sets workbox `navigateFallback: 'app-shell.html'`. Once the
 * worker is installed, any navigation it does not otherwise match is answered
 * from the precached shell, and React Router renders whatever the URL names —
 * a route, or its 404 page. That is right for app routes and wrong for files.
 * Opening https://familygreenhouse.net/sitemap.xml in a browser with the
 * worker installed showed the app's 404 page, while curl, a Chrome user agent
 * and Googlebot's all got `200 application/xml` from CloudFront. The server
 * was fine; the worker never asked it. Crawlers do not run service workers, so
 * search engines were never affected — people were.
 *
 * Workbox tests each pattern against `url.pathname + url.search`
 * (workbox-routing's NavigationRoute), so a pattern must look at the path
 * only: `/confirm-email?email=someone@example.com` has a dot, in its query.
 *
 *   1. `/api/` — unchanged: an API response is never the shell.
 *   2. `/.well-known/` — RFC 8615 files. `apple-app-site-association` has no
 *      extension, so rule 3 cannot see it; the CloudFront router exempts this
 *      prefix for the same reason (spa-router.js, rule 1b).
 *   3. A last path segment containing a dot — `/sitemap.xml`, `/robots.txt`,
 *      the IndexNow key file, `/brand/icon.svg`. It is the test the CloudFront
 *      router uses to tell a file from a route, so the worker and the edge
 *      agree on what a file is.
 *
 * No SPA route has a dot in its last segment. The router's paths are literal
 * words; `:slug` and `:topicId` come from the prerendered route list
 * (lowercase words and hyphens); `:plantId` is a v4 UUID; invite and share
 * codes are v4 UUIDs with the hyphens removed; sitter, kiosk, tag and
 * caretaker tokens are 64 hex characters. Links sent by email carry their data
 * in the query, which rule 3 ignores. tests/unit/config/navigateFallback.test.ts
 * checks every router path and every sitemap URL against this list, and fails
 * if a token generator changes shape, because a format that can contain a dot
 * (a JWT, say) needs its route prefix handled here rather than broken.
 *
 * A denied navigation is simply not intercepted: the browser fetches it from
 * the network, exactly as it would with no worker installed. So a wrong
 * denial costs a route its offline fallback, and nothing else.
 *
 * No `g` or `y` flags: workbox calls `.test()` on the same RegExp for every
 * navigation, and a stateful flag would make alternate calls disagree.
 *
 * Kept in a dependency-free module, like vite.manualChunks.ts, so the test runs
 * the exact array the build hands to workbox.
 */
export const NAVIGATE_FALLBACK_DENYLIST: RegExp[] = [
  /^\/api\//,
  /^\/\.well-known\//,
  /^[^?]*\.[^/?]*(?:\?.*)?$/,
];
