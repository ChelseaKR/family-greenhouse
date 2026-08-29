#!/usr/bin/env node
/**
 * Bake each public route's head and <h1> into its own copy of the built shell.
 *
 * The problem this solves: `index.html` is one file that served all 25 sitemap
 * URLs, so every one of them answered a crawler with the same title, the same
 * description, no <h1>, no canonical, no og:url and no structured data. Only
 * `useMetaTags` knew a route's head, and it runs after hydration — fine for a
 * browser, invisible to anything that does not execute JavaScript.
 *
 * Runs as `postbuild`, so it reads the shell AFTER vite and vite-plugin-pwa
 * have finished with it (hashed asset tags, injected manifest link) and writes:
 *
 *   dist/app.html                  the SPA fallback CloudFront serves for every
 *                                  route with no file of its own. Deliberately
 *                                  canonical-free — a canonical here would tell
 *                                  Google that every unmatched route is really
 *                                  the homepage — and marked `noindex`, because
 *                                  the origin answers 200 for ANY path, so
 *                                  /typo, /.env and /this-does-not-exist all
 *                                  render this shell. Without `noindex` that is
 *                                  an unbounded soft-404 space any stale or
 *                                  hostile link can add indexable URLs to.
 *                                  (A real 404 STATUS has to come from
 *                                  CloudFront; this is the half the repo owns.)
 *   dist/index.html                the prerendered "/" page
 *   dist/<route>/index.html        one per remaining public route
 *
 * Serving those files needs the CloudFront URI rewrite in
 * infrastructure/modules/frontend/functions/rewrite-uri.js (an S3 REST origin
 * does no directory-index resolution). Until that is applied the files are
 * written but unreachable; nothing regresses, the fix simply has not landed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seoRoutes } from './seo-routes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ROBOTS = join(ROOT, 'public', 'robots.txt');

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

/**
 * Replace the first match of `re`, or throw. A prerenderer that silently fails
 * to substitute a tag would ship the shell's homepage title under a care-guide
 * URL, which is precisely the defect it exists to fix — so a shell that no
 * longer has the tag we are looking for must break the build, loudly.
 */
function replaceOnce(html, re, replacement, what) {
  if (!re.test(html)) {
    throw new Error(`prerender: dist/index.html has no ${what} to replace (looked for ${re})`);
  }
  return html.replace(re, () => replacement);
}

function setTitle(html, title) {
  return replaceOnce(
    html,
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeText(title)}</title>`,
    '<title>'
  );
}

function setMetaContent(html, attr, name, content) {
  const re = new RegExp(`<meta\\s+${attr}="${name}"[^>]*>`);
  return replaceOnce(
    html,
    re,
    `<meta ${attr}="${name}" content="${escapeAttr(content)}" />`,
    `<meta ${attr}="${name}">`
  );
}

/**
 * `</` inside a <script> body ends the element no matter where it appears, so
 * a description containing "</p>" would break out of the JSON-LD block. The
 * JSON escape keeps the payload valid JSON and inert as markup.
 */
function jsonLdScript(payload) {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

/** Disallow prefixes robots.txt publishes for `User-agent: *`. */
export function disallowedPrefixes(robotsTxt) {
  const prefixes = [];
  let inWildcardGroup = false;
  for (const line of robotsTxt.split('\n')) {
    const text = line.split('#')[0].trim();
    if (text === '') continue;
    const [rawField, ...rest] = text.split(':');
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (field === 'user-agent') inWildcardGroup = value === '*';
    else if (field === 'disallow' && inWildcardGroup && value !== '') prefixes.push(value);
  }
  return prefixes;
}

/** True when robots.txt tells every crawler to stay off `path`. */
export function isDisallowed(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * The SPA fallback: the shell with `noindex` added and nothing else changed.
 * Every unmatched path renders it with a 200, so it must never be indexable.
 * Routes that need to be indexed get a prerendered page of their own; a route
 * served this shell that later wants indexing would have to say so itself, by
 * passing `robots: 'index, follow'` to useMetaTags. None does today.
 */
export function fallbackShell(shell) {
  return replaceOnce(
    shell,
    /<\/head>/,
    '\n    <meta name="robots" content="noindex" />\n  </head>',
    '</head>'
  );
}

/** Build one route's HTML from the built shell. */
export function renderRoute(shell, route) {
  let html = setTitle(shell, route.title);
  html = setMetaContent(html, 'name', 'description', route.description);
  html = setMetaContent(html, 'property', 'og:title', route.title);
  html = setMetaContent(html, 'property', 'og:description', route.description);
  html = setMetaContent(html, 'property', 'og:type', route.ogType);
  html = setMetaContent(html, 'name', 'twitter:title', route.title);
  html = setMetaContent(html, 'name', 'twitter:description', route.description);

  const head = [
    `<link rel="canonical" href="${escapeAttr(route.canonical)}" />`,
    `<meta property="og:url" content="${escapeAttr(route.canonical)}" />`,
    route.jsonLd ? jsonLdScript(route.jsonLd) : null,
  ].filter(Boolean);
  html = replaceOnce(html, /<\/head>/, `\n    ${head.join('\n    ')}\n  </head>`, '</head>');

  // Inside #root, so React's first commit clears it: the browser never shows
  // both this and the hydrated page. Pinned by
  // tests/unit/seo/prerenderedShell.test.tsx.
  const body = [
    `<div id="root">`,
    `      <div data-prerendered-route="${escapeAttr(route.path)}">`,
    `        <h1>${escapeText(route.heading)}</h1>`,
    `        <p>${escapeText(route.description)}</p>`,
    `      </div>`,
    `    </div>`,
  ].join('\n');
  return replaceOnce(html, /<div id="root"><\/div>/, body, '<div id="root">');
}

function main() {
  const shell = readFileSync(join(DIST, 'index.html'), 'utf8');
  const prefixes = disallowedPrefixes(readFileSync(ROBOTS, 'utf8'));
  const routes = seoRoutes();

  const blocked = routes.filter((r) => isDisallowed(r.path, prefixes));
  if (blocked.length > 0) {
    throw new Error(
      `prerender: robots.txt disallows ${blocked.map((r) => r.path).join(', ')}. ` +
        'A route is either crawlable or it is not; do not publish a page for one that is not.'
    );
  }

  writeFileSync(join(DIST, 'app.html'), fallbackShell(shell));

  for (const route of routes) {
    const html = renderRoute(shell, route);
    const out =
      route.path === '/'
        ? join(DIST, 'index.html')
        : join(DIST, route.path.replace(/^\//, ''), 'index.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
  }

  console.log(`Prerendered ${routes.length} public routes into dist/ (plus dist/app.html).`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
