/**
 * The app's CLIENT-SIDE route table, read from `src/App.tsx`, so the CloudFront
 * viewer-request function can tell a URL this app answers for from a URL that
 * does not exist.
 *
 * ## Why this exists (issue #719)
 *
 * `familygreenhouse.net` answered **HTTP 200 to every URL**. Measured live on
 * 2026-09-13: `/definitely-not-a-page`, `/blog/no-such-post` and
 * `/care/no-such-plant` each returned 200 with the same 4,715-byte app shell.
 * It was the only host of the twelve in this portfolio that did; every other
 * one, including the other S3/CloudFront ones, returns a hard 404.
 *
 * The `noindex` on the shell means this was never an index-pollution problem.
 * It is a machine-readability one: **nothing outside a browser could tell "this
 * care guide does not exist" from "this care guide exists"**, because a 200 is
 * an assertion that the resource is there. That is this repository's own
 * "absence rendered as a value" defect, moved down to the HTTP layer.
 *
 * The consequence worth stating: a link check against that host **cannot
 * fail**. The crawl that filed #719 ran a 638-link same-origin sweep and
 * reported zero broken links on familygreenhouse.net — and could not have
 * reported otherwise.
 *
 * ## Why the route list has to come from App.tsx
 *
 * `spa-router.js` already knows the PRERENDERED public pages. It could not tell
 * `/dashboard` (a real route, no prerendered file, must boot the app) from
 * `/dashboard-typo` (nothing), so it gave both the shell. The only source of
 * truth for that distinction is the `<Routes>` table React Router itself
 * matches against — which is why this reads it rather than restating it.
 *
 * That is also what makes the change safe: every URL this turns from 200 into
 * 404 is, by construction, a URL React Router already resolved to its `*`
 * route and rendered as NotFoundPage. No page that worked stops working; a
 * page that was already "not found" starts saying so in the status line.
 *
 * ## Why the regex, and what it must not miss
 *
 * Same reasoning as `public-routes.mjs`: importing a `.tsx` module from a
 * vanilla Node script needs a loader, and the `<Route path="…">` attributes are
 * double-quoted literals on a stable line shape. The risk specific to THIS
 * parser is the one that costs a customer — a route it fails to see 404s in
 * production — so `appRoutes()` compares what it parsed against an independent
 * count of the bare `path=` attributes in the file and throws on any
 * difference. `spa-router.test.mjs` then walks the classification and asserts
 * the edge function routes a concrete URL for each one to the shell.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRONTEND_ROOT, PREFIX_SERVED_NAMESPACES } from './public-routes.mjs';

const APP = join(FRONTEND_ROOT, 'src', 'App.tsx');

/**
 * Dynamic routes whose valid members are ALREADY enumerated in the
 * prerendered-route map, and which are therefore deliberately NOT treated as
 * "any segment matches".
 *
 * These are the three content namespaces. Every real `/care/:slug`,
 * `/blog/:slug` and `/help/:topicId` comes from a manifest that
 * `public-routes.mjs` reads, is prerendered, and is listed in `sitemap.xml` —
 * so a path under one of them that is not in PRERENDERED cannot exist, and is
 * exactly the case #719 names as the most likely landing place for a stale
 * external link.
 *
 * Listing them here rather than hard-coding the exclusion in the parser is the
 * point: `appRoutes()` throws if one of these is no longer a route in App.tsx,
 * so the day `/care/:slug` stops being manifest-driven, this decision is
 * revisited instead of silently 404ing real pages.
 */
export const ENUMERATED_NAMESPACE_ROUTES = ['/blog/:slug', '/care/:slug', '/help/:topicId'];

/**
 * Dynamic routes whose valid members are served at the edge by PREFIX (see
 * `PREFIX_SERVED_NAMESPACES` in public-routes.mjs), and which are therefore
 * also NOT "any segment reaches the app".
 *
 * `/pet-safe/:slug` is generated from the curated pet-toxicity table. Its pages
 * are prerendered like the three namespaces above, but they are not listed in
 * `PRERENDERED` one by one (the function's 10 KB limit); the function maps any
 * single segment under the prefix onto its object, and a slug that was never
 * published is S3's 404. Routing it to the shell instead would answer 200 for
 * every plant name anyone types, which is #719 again.
 *
 * `appRoutes()` throws if one of these stops being a route, or stops matching a
 * prefix in `PREFIX_SERVED_NAMESPACES`.
 */
export const PREFIX_SERVED_NAMESPACE_ROUTES = ['/pet-safe/:slug'];

/** Every `path="…"` on a `<Route>` in App.tsx, in source order. */
export function declaredRoutePaths(source = readFileSync(APP, 'utf8')) {
  return [...source.matchAll(/<Route\b[^>]*?\bpath="([^"]*)"/gs)].map((m) => m[1]);
}

/**
 * Count of `path=` attributes in App.tsx, however they are spelled.
 *
 * The "examined vs examinable" number. `declaredRoutePaths()` reports what the
 * parser SAW; this reports what was there to see, and the two are compared in
 * `appRoutes()`.
 *
 * It deliberately shares NOTHING with the parser's pattern — no `<Route`
 * prefix, no quotes, no capture. A first draft counted
 * `/<Route\b[^>]*?\bpath=/`, which is the parser's own prefix, so every way
 * the parser could go blind blinded the counter too and the comparison could
 * not fail: `[^>]*?` cannot cross the `>` inside `element={<X />}`, so
 * `<Route element={<X />} path="/y" />` is invisible to both. Counting the bare
 * attribute catches that, and `path={CONST}`, and a single-quoted value.
 *
 * A non-`<Route>` `path=` prop in this file would read as a mismatch. That is
 * the safe direction — it names itself and stops the build, where the other
 * direction ships a route that answers 404 to customers.
 */
export function declaredPathAttributeCount(source = readFileSync(APP, 'utf8')) {
  return [...source.matchAll(/\bpath=/g)].length;
}

/**
 * The client route table, classified for the edge function.
 *
 * - `exact`    — routes with no `:param`, minus the ones already prerendered.
 * - `patterns` — routes with a `:param`, rewritten with `*` for the parameter
 *                segment. React Router matches one non-empty segment per
 *                `:param`, so segment count plus literal equality is exact.
 * - `enumerated` — ENUMERATED_NAMESPACE_ROUTES, excluded on purpose.
 * - `prefixServed` — PREFIX_SERVED_NAMESPACE_ROUTES, excluded on purpose.
 * - `skipped`  — `/` (the function resolves it directly) and `*` (the
 *                catch-all, which is precisely what must stop meaning 200).
 *
 * `prerenderedPaths` is passed in so this module does not decide what is
 * public; `build-spa-router.mjs` hands it the list `public-routes.mjs` owns.
 */
export function appRoutes(prerenderedPaths, source = readFileSync(APP, 'utf8')) {
  const declared = declaredRoutePaths(source);
  const seen = declaredPathAttributeCount(source);
  if (declared.length !== seen) {
    throw new Error(
      `App.tsx carries ${seen} \`path=\` attributes and only ${declared.length} parsed as ` +
        '`<Route … path="…">`. A route this parser cannot see is a route that answers 404 in ' +
        'production, so the difference is refused rather than shipped: widen the parser, or ' +
        'spell the attribute as a double-quoted literal on the <Route> itself.'
    );
  }

  const missing = ENUMERATED_NAMESPACE_ROUTES.filter((route) => !declared.includes(route));
  if (missing.length > 0) {
    throw new Error(
      `ENUMERATED_NAMESPACE_ROUTES lists ${missing.join(', ')}, which App.tsx no longer ` +
        "declares. Those namespaces are excluded from the edge function's route table " +
        'because every valid member is prerendered; if that is no longer how they work, ' +
        'the exclusion has to be revisited rather than left in place.'
    );
  }

  const unservedPrefix = PREFIX_SERVED_NAMESPACE_ROUTES.filter(
    (route) =>
      !declared.includes(route) || !PREFIX_SERVED_NAMESPACES.includes(route.replace(/:[^/]+$/, ''))
  );
  if (
    unservedPrefix.length > 0 ||
    PREFIX_SERVED_NAMESPACES.length !== PREFIX_SERVED_NAMESPACE_ROUTES.length
  ) {
    throw new Error(
      `PREFIX_SERVED_NAMESPACE_ROUTES (${PREFIX_SERVED_NAMESPACE_ROUTES.join(', ')}) must each be a ` +
        'route App.tsx declares, one `:param` below a prefix in PREFIX_SERVED_NAMESPACES ' +
        `(${PREFIX_SERVED_NAMESPACES.join(', ')}), and the two lists must pair up. A prefix the ` +
        'function serves with no route behind it, or a route with no prefix, answers 404 or 200 ' +
        'for the wrong URLs.'
    );
  }

  const publicSet = new Set(prerenderedPaths);
  const exact = [];
  const patterns = [];

  for (const path of declared) {
    if (path === '/' || path === '*') continue;
    if (ENUMERATED_NAMESPACE_ROUTES.includes(path)) continue;
    if (PREFIX_SERVED_NAMESPACE_ROUTES.includes(path)) continue;
    if (path.includes(':')) {
      const pattern = path.replace(/:[^/]+/g, '*');
      if (!patterns.includes(pattern)) patterns.push(pattern);
      continue;
    }
    // A prerendered page is already in PRERENDERED; repeating it here would
    // grow the function for nothing, and the function is capped at 10 KB.
    if (publicSet.has(path)) continue;
    if (!exact.includes(path)) exact.push(path);
  }

  exact.sort();
  patterns.sort();
  return {
    exact,
    patterns,
    enumerated: [...ENUMERATED_NAMESPACE_ROUTES],
    prefixServed: [...PREFIX_SERVED_NAMESPACE_ROUTES],
    declared,
  };
}

/**
 * A concrete URL that React Router matches for `path`, for tests that need to
 * prove the edge function agrees with the route table. `:param` becomes a
 * plausible opaque segment; a literal path is itself.
 */
export function sampleUrlFor(path) {
  return path.replace(/:[^/]+/g, 'sample-segment-1');
}
