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
