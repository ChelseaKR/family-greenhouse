#!/usr/bin/env node
/**
 * Synthetic page check: fetch real pages and prove they are still THIS app.
 *
 * Why this exists (issue #464). `.github/workflows/uptime.yml` curls the API's
 * `/health` endpoint and asserts `.status == "ok"`. On 2026-09-04 that job ran
 * fourteen minutes into a total frontend outage — every route except `/` was
 * answering 403 — and reported success, because the API was fine and the check
 * never loaded a page. An availability check that only ever looks at the API
 * cannot see a frontend outage.
 *
 * What it asserts, per route, and why each assertion is here rather than a
 * bare `test "$code" = 200`:
 *
 *   1. HTTP 200. The floor, and the only thing the old check had.
 *   2. `Content-Type: text/html`. S3 and CloudFront both answer errors with
 *      XML; a 200 that is not HTML is not a page.
 *   3. Same-origin final URL. `fetch` follows redirects, so a redirect off to
 *      a parked domain or a hosting provider's placeholder would otherwise
 *      pass on its 200.
 *   4. The app root element (`<div id="root">`). This is the mount point in
 *      `frontend/index.html`; without it the bundle has nowhere to render and
 *      the visitor sees a blank page no matter what the status code says.
 *   5. A `<script type="module" src="...">` tag. The root element alone can be
 *      served by a truncated or half-deployed shell; the module script is what
 *      actually boots the app.
 *   5b. THAT SCRIPT ACTUALLY FETCHES, as JavaScript (issue #615). The tag is
 *      markup; the bundle is the app. A deploy that dropped the JS chunk left
 *      every assertion above true and no browser able to start, because a
 *      missing `/assets/` object came back as `200 text/html` — the shell,
 *      carrying the very `og:site_name` string assertion 6 matches. This is the
 *      first assertion here that a shell cannot satisfy on its own, and it is
 *      the reason a total bundle loss is now visible to a check rather than
 *      only to a visitor.
 *   6. `og:site_name` equal to the site name. This is the identity assertion —
 *      it distinguishes "our app is being served" from "some other 200-serving
 *      HTML is being served here". It holds for both the SPA shell and every
 *      prerendered page, because `headToTags()` in
 *      `frontend/src/config/seo.ts` emits it unconditionally.
 *   7. A non-empty `<title>`.
 *
 * Deliberately NOT asserted: per-route titles, canonicals, or rendered body
 * text. Those belong to the prerender gate
 * (`frontend/scripts/check-prerender-coverage.mjs`), which runs at build time
 * against `dist/`. This script has to keep passing against whatever build is
 * currently deployed, so it asserts only what every shipped build of this app
 * has in common.
 *
 * `--missing-asset-404` swaps the route probe for one assertion about the CDN
 * itself: a fabricated `/assets/` path must answer 404, and must NOT contain
 * the string `aws_route53_health_check.site` searches for. That is the contract
 * #615 established — under `/assets/` every name is content-addressed, so the
 * object exists or it does not, and the SPA shell is never the right answer.
 *
 * It lives on the release path (`cd-production.yml`'s post-deploy smoke), not
 * on the fifteen-minute cron, because it asserts a property of the distribution
 * that only becomes true when `terraform apply` runs. On the cron it would page
 * every fifteen minutes for the gap between a merge and the next release, about
 * a difference between `main` and production that is expected. Its logic is
 * pure and unit-tested (`scripts/synthetic-page-check.test.mjs`) so it cannot
 * quietly stop meaning anything between releases.
 *
 * `--expect-failure` inverts the exit code. That is not a convenience: it is
 * how the workflow proves the check can still fail. A check that cannot fail
 * is worse than no check, so `uptime.yml` runs this script a second time
 * against a URL that is deliberately not an app page and requires it to
 * report a failure.
 *
 * Zero dependencies on purpose — global `fetch`, no npm install, so the job
 * stays a checkout plus one `node` invocation every fifteen minutes.
 *
 * Usage:
 *   node scripts/synthetic-page-check.mjs --base-url https://familygreenhouse.net
 *   node scripts/synthetic-page-check.mjs --base-url https://example.test \
 *     --route /robots.txt --expect-failure
 */
import process from 'node:process';

/**
 * Must match `SITE_NAME` in `frontend/src/config/seo.ts`, which is what puts
 * this string into every page's `og:site_name`.
 */
const SITE_NAME = 'Family Greenhouse';

/**
 * The routes worth probing: the marketing root plus the three public routes a
 * new or returning visitor needs. `/register` and `/login` are the ones the
 * 2026-09-04 outage broke while `/` still answered.
 */
export const DEFAULT_ROUTES = ['/', '/register', '/login', '/pricing'];

const DEFAULT_TIMEOUT_MS = 20_000;

/** The mount point React renders into (frontend/index.html). */
const APP_ROOT = /<div\s+id="root"[\s>]/u;

/**
 * The module script that boots the bundle. Matches dev and built output, and
 * captures the `src` so the bundle behind it can be fetched too.
 */
const MODULE_SCRIPT = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/u;

/**
 * Content types a served JavaScript bundle may legitimately answer with. The
 * one this exists to reject is `text/html`: before #615 a missing chunk was
 * answered with the SPA shell, and `x-content-type-options: nosniff` then made
 * the browser refuse it on a MIME mismatch rather than a clean 404.
 */
const JS_CONTENT_TYPES = new Set([
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'module',
]);

/**
 * A path under `/assets/` that cannot exist: every real name there carries the
 * content hash of its own bytes. Used by `--missing-asset-404`.
 */
const FABRICATED_ASSET = '/assets/index-DOESNOTEXIST.js';

/**
 * The literal `aws_route53_health_check.site` searches for
 * (`site_health_check_search_string` in modules/monitoring/variables.tf). A
 * missing asset that contains this is the #615 failure exactly: the monitor
 * built to see a frontend outage reading a 404 as the app.
 */
const HEALTH_CHECK_STRING = `<meta property="og:site_name" content="${SITE_NAME}" />`;

/** `og:site_name`, emitted by headToTags() for the shell and every page. */
const SITE_NAME_META = /<meta\s+property=["']og:site_name["']\s+content=["']([^"']*)["']/u;

const TITLE = /<title>([^<]*)<\/title>/u;

/**
 * Evaluate one fetched page. Pure: takes what a response gave us and returns
 * the list of reasons it is not a served page of this app. An empty list means
 * the page passed.
 */
export function pageFailures({ status, contentType, finalUrl, origin, body }) {
  const failures = [];

  if (status !== 200) {
    failures.push(`HTTP ${status} (expected 200)`);
  }

  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'text/html') {
    failures.push(`Content-Type ${type || '<missing>'} (expected text/html)`);
  }

  if (finalUrl && origin && !finalUrl.startsWith(origin)) {
    let redirectedTo = '<unparseable>';
    try {
      redirectedTo = new URL(finalUrl).origin;
    } catch {
      // Keep the failure readable without echoing an arbitrary string.
    }
    failures.push(`redirected off-origin to ${redirectedTo}`);
  }

  const html = body ?? '';

  if (!APP_ROOT.test(html)) {
    failures.push('no <div id="root"> — the app has nowhere to mount');
  }

  if (!MODULE_SCRIPT.test(html)) {
    failures.push('no <script type="module" src=...> — the app bundle is not loaded');
  }

  const siteName = SITE_NAME_META.exec(html)?.[1];
  if (siteName !== SITE_NAME) {
    failures.push(
      `og:site_name is ${siteName === undefined ? 'missing' : `"${siteName}"`} (expected "${SITE_NAME}") — this is not a page of this app`
    );
  }

  const title = TITLE.exec(html)?.[1]?.trim();
  if (!title) {
    failures.push('empty or missing <title>');
  }

  return failures;
}

/** The `src` of the module script a page advertises, or undefined. */
export function moduleScriptSrc(body) {
  return MODULE_SCRIPT.exec(body ?? '')?.[1];
}

/**
 * Evaluate the response to the bundle a page pointed at. Pure, like
 * `pageFailures`, so the assertion #615 turns on can be exercised without a
 * network. A bundle is only served if it answers 200 with a JavaScript content
 * type from this same origin — `text/html` here IS the bug: it is the SPA shell
 * standing in for a chunk that is not there.
 */
export function bundleFailures({ src, status, contentType, finalUrl, origin }) {
  const failures = [];
  const where = `module script ${src}`;

  if (status !== 200) {
    failures.push(`${where} answered HTTP ${status} — the app bundle is not being served`);
  }

  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!JS_CONTENT_TYPES.has(type)) {
    failures.push(
      `${where} answered Content-Type ${type || '<missing>'}, not JavaScript` +
        (type === 'text/html' ? ' — this is the SPA shell standing in for a missing chunk' : '')
    );
  }

  if (finalUrl && origin && !finalUrl.startsWith(origin)) {
    failures.push(`${where} resolved off-origin`);
  }

  return failures;
}

/**
 * Evaluate the response to a fabricated `/assets/` path. Pure. Two assertions,
 * and the second is the one that names the harm: a 200 here would be the shell,
 * and the shell carries the literal `aws_route53_health_check.site` matches, so
 * a distribution serving it cannot be distinguished from a healthy one by the
 * monitor built to catch a frontend outage (#464, #615).
 */
export function missingAssetFailures({ status, body }) {
  const failures = [];

  if (status !== 404) {
    failures.push(
      `HTTP ${status} for ${FABRICATED_ASSET} (expected 404). Under /assets/ every ` +
        'name carries the hash of its own bytes: the object exists or it does not, and ' +
        'the SPA shell is never the right answer.'
    );
  }

  if ((body ?? '').includes(HEALTH_CHECK_STRING)) {
    failures.push(
      `the response to ${FABRICATED_ASSET} contains the site health check's search ` +
        'string, so a total loss of the JS bundle would read as healthy to Route 53'
    );
  }

  return failures;
}

const USER_AGENT = 'family-greenhouse-synthetic-page-check';

/**
 * Fetch one URL with a timeout. Returns the shape the pure predicates want.
 *
 * `method` is HEAD for the bundle probe. That assertion is about the status
 * and the content type, and the production bundle is 68 KB: pulling it four
 * times every fifteen minutes is ~800 MB a month of egress bought for a header.
 * CloudFront serves HEAD from the same cache entry as GET, so it is the same
 * object being asserted about. The route probe and the missing-asset probe
 * stay GET because both read the body.
 */
async function fetchOnce(url, timeoutMs, method = 'GET') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      finalUrl: response.url,
      body: method === 'HEAD' ? '' : await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch one route and evaluate it. Never throws for a network failure. */
export async function checkRoute(baseUrl, route, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const origin = new URL(baseUrl).origin;
  const url = new URL(route, baseUrl).href;

  try {
    const page = await fetchOnce(url, timeoutMs);
    const failures = pageFailures({ ...page, origin });

    // #615: follow the bundle the page just claimed boots it. Only worth doing
    // when the page itself looked like a page — if the shell is missing or is
    // not HTML there is nothing here the reader does not already know.
    const src = moduleScriptSrc(page.body);
    if (src !== undefined && failures.length === 0) {
      const bundleUrl = new URL(src, page.finalUrl || url).href;
      try {
        const bundle = await fetchOnce(bundleUrl, timeoutMs, 'HEAD');
        failures.push(...bundleFailures({ src: bundleUrl, ...bundle, origin }));
      } catch (error) {
        const reason = error instanceof Error ? (error.name ?? 'Error') : 'Error';
        failures.push(`module script ${bundleUrl} could not be fetched (${reason})`);
      }
    }

    return { route, url, status: page.status, failures };
  } catch (error) {
    // A DNS failure, a TLS failure, a connection reset, or the abort above.
    // All of them are the outage this check exists to see.
    const reason = error instanceof Error ? (error.name ?? 'Error') : 'Error';
    return { route, url, status: 0, failures: [`request failed (${reason})`] };
  }
}

/**
 * Fetch a fabricated `/assets/` path and evaluate the CDN's answer. Separate
 * from `checkRoute` because it is an assertion about the distribution, not
 * about a page.
 */
export async function checkMissingAsset(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = new URL(FABRICATED_ASSET, baseUrl).href;
  try {
    const response = await fetchOnce(url, timeoutMs);
    return {
      route: FABRICATED_ASSET,
      url,
      status: response.status,
      failures: missingAssetFailures(response),
    };
  } catch (error) {
    const reason = error instanceof Error ? (error.name ?? 'Error') : 'Error';
    return { route: FABRICATED_ASSET, url, status: 0, failures: [`request failed (${reason})`] };
  }
}

/** Minimal flag parser: `--flag value`, plus repeatable `--route`. */
function parseArgs(argv) {
  const options = {
    routes: [],
    expectFailure: false,
    missingAsset404: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return next;
    };

    if (arg === '--base-url') options.baseUrl = value();
    else if (arg === '--route') options.routes.push(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--expect-failure') options.expectFailure = true;
    else if (arg === '--missing-asset-404') options.missingAsset404 = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.baseUrl) throw new Error('--base-url is required');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  if (options.routes.length === 0) options.routes = [...DEFAULT_ROUTES];
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  // Sequential on purpose: four requests every fifteen minutes is not worth
  // parallelising, and a serial run keeps the log readable when one fails.
  const results = [];
  if (options.missingAsset404) {
    results.push(await checkMissingAsset(options.baseUrl, options.timeoutMs));
  } else {
    for (const route of options.routes) {
      results.push(await checkRoute(options.baseUrl, route, options.timeoutMs));
    }
  }

  for (const result of results) {
    if (result.failures.length === 0) {
      console.log(`ok    ${result.route} (HTTP ${result.status})`);
    } else {
      console.log(`FAIL  ${result.route} (HTTP ${result.status})`);
      for (const failure of result.failures) console.log(`        ✗ ${failure}`);
    }
  }

  const failed = results.filter((result) => result.failures.length > 0);

  if (options.expectFailure) {
    if (failed.length === 0) {
      console.error(
        `\nNegative control FAILED: every route passed, but --expect-failure means at least one had to fail. ` +
          `The synthetic page check can no longer detect a broken page, so it is no longer a check.`
      );
      return 1;
    }
    console.log(
      `\nNegative control OK: ${failed.length} of ${results.length} route(s) failed as required.`
    );
    return 0;
  }

  if (failed.length > 0) {
    console.error(
      `\nSynthetic page check FAILED for ${failed.length} of ${results.length} route(s) on ${options.baseUrl}.`
    );
    return 1;
  }

  console.log(
    `\nSynthetic page check OK: ${results.length} route(s) served the app on ${options.baseUrl}.`
  );
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
