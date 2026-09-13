# 0013 — Build-time prerendering of the public routes

**Status:** Accepted

**Date:** 2026-08-28

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0002](0002-serverless-on-aws.md) (S3 + CloudFront is what serves the SPA)

## Context

A technical SEO audit of the live site on 2026-08-28 fetched all 25 sitemap
URLs and found the same page 25 times. Every one of them served `index.html`
verbatim, so to any crawler that does not execute JavaScript:

- all 25 shared one `<title>` and one meta description,
- all 25 had zero `<h1>`,
- all 25 had no `<link rel="canonical">` and no `og:url`,
- all 25 had no structured data.

None of that was an oversight in the pages. `useMetaTags` set a correct
per-route title, description, canonical, og:url and JSON-LD — after hydration.
The comment in `index.html` explaining why there is no static canonical was
right about the risk (a hardcoded homepage canonical on the one shell would
canonicalize `/pricing`, `/care/pothos` and the rest to `/`) and the mitigation
was sound for browsers. It simply could not reach anything that does not run
JS. `/care/*` and `/blog/*` exist to be found in search; they were
indistinguishable from each other in the bytes the origin returned.

Three ways out were considered.

1. **Server-side rendering.** Correct, and far too much: it means an SSR
   runtime in front of an S3 origin, a second execution environment for
   components that assume a browser (`zustand` persistence, `i18next`
   detection, TanStack Query), and a rewrite of the deploy.
2. **A prerendering framework** (vite-react-ssg, vite-plugin-ssr). Renders the
   real components, which is the honest version — and brings a framework, a
   second router configuration, and a class of hydration mismatch this codebase
   has never had to reason about.
3. **Build-time head + heading generation from a route manifest.** No new
   runtime, no framework, no component execution outside the browser.

## Decision

Option 3. A route manifest (`frontend/src/config/publicRoutes.ts`, plus the
existing `careGuides.ts` and `posts/meta.ts` content manifests) states each
public route's title, description, `<h1>` and structured data. The React pages
read it, so the head they set after hydration comes from the same words.
`scripts/prerender.mjs` runs as `postbuild` and writes one copy of the built
shell per route, with that route's head and heading baked in.

Three consequences of that shape are load-bearing:

- **The manifest modules are plain Node-loadable TypeScript.** Their relative
  imports carry `.ts` extensions and they contain no `@/` aliases and no React,
  so the build scripts import them directly under Node's type stripping rather
  than keeping a second copy of every title. That constraint is stated in each
  of those files.
- **The prerendered heading lives inside `#root`.** React clears its container
  on the first commit, so the crawler copy and the hydrated page are never both
  on screen. That is pinned by a test, not assumed.
- **The SPA fallback is a separate file.** `dist/app.html` is the shell with no
  canonical and a `noindex`; CloudFront's 403/404 rule points at it instead of
  `index.html`. Without that split, `index.html` — now the prerendered landing
  page, carrying `rel="canonical" href="https://familygreenhouse.net/"` — would
  be served for every unmatched URL and would tell Google that all of them are
  the homepage. The `noindex` is separately necessary because that rule answers
  200 for **any** path, so `/typo` and `/this-does-not-exist` render a page.

Serving the per-route files needs one more thing: the frontend bucket is a REST
(OAC) origin, which does no directory-index resolution, so
`aws_cloudfront_function.rewrite_uri` maps `/care/pothos` to
`/care/pothos/index.html`. Its behavior is pinned by a unit test that runs the
shipped file, because it sits in front of every request to the site.

## Consequences

**What we get.** Every public URL answers with its own title, description,
self-referencing absolute apex canonical, `og:url`, single `<h1>` and (where
the route has one) its schema.org graph, with no JavaScript. The sitemap and
the prerendered set are generated from one list, and `scripts/check-seo-build.mjs`
re-checks that against `dist/` from the other direction.

**What we accept.** The prerendered body is a heading and a summary, not the
page. A JS-less reader gets an accurate but thin page; a search engine gets an
accurate head, which is what it ranks on. Adding a public route now means
adding a manifest entry, and the build gate fails if the sitemap and the
prerendered set disagree — deliberately, because the failure being prevented is
a URL that quietly serves another page's title.

**What stays broken until an apply.** The prerendered files are unreachable in
production until `terraform apply` publishes the CloudFront function and
repoints the SPA fallback. Nothing regresses in the meantime; the fix is simply
not live yet.

**What this does not fix.** `https://www.familygreenhouse.net/` still serves
byte-identical content with no redirect to the apex. The canonicals are now
absolute and always apex-hosted, which is the in-repo half; a www→apex 301
belongs in `infrastructure/modules/frontend/main.tf` and is not attempted here.
Neither is a real 404 **status** for unknown paths, which is the same
`custom_error_response` block.

## Update — 2026-09-05 (issue #615)

The last paragraph above is now half true, and the half that changed is worth
recording here rather than only in the module.

A real 404 **status** for a missing FILE now exists. `/assets/<name>` and any
other path with an extension answer 404 when the object is not there, because
the `404 → 200` rule was removed from the `custom_error_response` block and the
frontend bucket was granted `s3:ListBucket` (which is what makes S3 answer
`NoSuchKey` rather than `AccessDenied` for a missing key). That mattered
because `custom_error_response` is a property of the distribution, not of a
cache behavior, so it could not be told to skip `/assets/` — a missing JS chunk
came back as `200 text/html`, the SPA shell, carrying the very `og:site_name`
tag `aws_route53_health_check.site` matches.

Paying for that meant the viewer-request function taking over the job the
error rule was doing for routes: it now resolves every non-prerendered route to
`/app-shell.html` **by name**, which is why it carries a generated copy of the
public-route list (`npm run spa-router --workspace frontend`, gated by
`spa-router:check`). The split this ADR describes — `app-shell.html` as the
`noindex`, canonical-free shell, distinct from the prerendered `index.html` —
is unchanged and is now load-bearing in one more place.

Unknown **routes** still answer 200 with that shell, and deliberately: an SPA
route that the client resolves is not a 404 at the CDN. `/plants/{plantId}`
also still relies on the surviving `403 → 200` rule, because the images cache
behavior shares its path prefix.

## Update — 2026-09-13 (issue #719)

The last paragraph above was wrong in one word, and the word did the damage.

"Unknown **routes** still answer 200" was written about SPA routes the client
resolves — `/dashboard`, `/plants/{plantId}` — and that part is still right.
But the function could not tell those from URLs that resolve to nothing, so
the rule it actually implemented was _every_ extensionless path answers 200.
Measured on the live host on 2026-09-13: `/definitely-not-a-page`,
`/blog/no-such-post` and `/care/no-such-plant` all returned 200 with the same
4,715-byte shell, on the only host of twelve in this portfolio that did.

The shell is `noindex`, so this was never about the index. It is about
machine-readability: a 200 asserts the resource exists, so nothing outside a
browser could distinguish a care guide that is missing from one that is there —
and a link check on this host could not fail. The crawl that filed #719 swept
638 same-origin links, reported zero broken here, and could not have reported
otherwise.

The distinction the first sentence assumed now exists in the code. The
viewer-request function carries a second generated list, `APP_EXACT` /
`APP_PATTERNS`, derived from `src/App.tsx` by
`frontend/scripts/app-routes.mjs` — the same `<Routes>` table React Router
matches. A path in neither that list nor `PRERENDERED` is left alone, so S3
answers 404. Every URL that moves from 200 to 404 is one React Router already
resolved to its `*` route, so nothing that rendered a page stops rendering it.

`/blog/:slug`, `/care/:slug` and `/help/:topicId` are deliberately excluded
from `APP_PATTERNS`: every valid member is manifest-driven and already in
`PRERENDERED`, which is what makes `/care/no-such-plant` answerable at all.

What this still does not fix: the 404 **body** is S3's error document rather
than a branded page. Serving the shell there needs a distribution-wide
`error_code = 404` rule, which would also answer for `/assets/` — where the
post-deploy smoke (`synthetic-page-check.mjs --missing-asset-404`) requires the
body NOT to contain the string `aws_route53_health_check.site` matches, and
where `observability:check` fails on `error_code = 404` reappearing in
`modules/frontend/main.tf` for exactly that reason. Status and body are
separable, and only the status changed here. `/plants/{plantId}` is also
untouched: that prefix is served by the images cache behavior, which has no
function association and still relies on the `403 → 200` rule.
