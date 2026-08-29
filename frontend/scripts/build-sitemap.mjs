#!/usr/bin/env node
/**
 * Emit `public/sitemap.xml` from the same route list the prerenderer uses, so
 * the sitemap and the prerendered set cannot disagree about which URLs exist.
 * Runs as a `prebuild` step, before vite copies /public/* into dist.
 *
 * `lastmod` comes from real content change dates, never from "today":
 *
 *   - a route with a hand-maintained content date (a post's `date`, a care
 *     guide's `reviewed`) starts from that date;
 *   - a route with source files of its own takes the date of the last commit
 *     that touched them, when that is later;
 *   - and when git history is unavailable (a shallow CI clone, a source
 *     tarball), the git half is skipped rather than guessed. A route with no
 *     content date then ships with no <lastmod>, which is what the sitemap
 *     protocol wants: the tag is optional, and a wrong date is worse than none.
 *
 * The file is generated, not committed (see .gitignore). It used to be tracked
 * and went stale by months, advertising June dates for pages edited in August.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seoRoutes } from './seo-routes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const OUT = join(ROOT, 'public', 'sitemap.xml');

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** True when this checkout has enough history to date a file honestly. */
function hasUsableHistory() {
  try {
    return git(['rev-parse', '--is-shallow-repository']) === 'false';
  } catch {
    return false;
  }
}

/** Commit date (YYYY-MM-DD) of the last change to `path`, or null. */
function lastCommitDate(path) {
  try {
    return git(['log', '-1', '--format=%cs', '--', path]) || null;
  } catch {
    return null;
  }
}

function lastmodFor(route, historyAvailable) {
  const dates = [route.contentDate];
  if (historyAvailable) {
    for (const source of route.dateSources) dates.push(lastCommitDate(source));
  }
  const known = dates.filter(
    (d) => typeof d === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)
  );
  if (known.length === 0) return null;
  return known.sort().at(-1);
}

function urlEntry({ loc, changefreq, priority, lastmod }) {
  const lines = [
    `  <url>`,
    `    <loc>${loc}</loc>`,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority.toFixed(1)}</priority>`,
  ];
  if (lastmod) lines.push(`    <lastmod>${lastmod}</lastmod>`);
  lines.push(`  </url>`);
  return lines.join('\n');
}

function build() {
  const historyAvailable = hasUsableHistory();
  if (!historyAvailable) {
    console.warn(
      'build-sitemap: no usable git history (shallow clone?). Dating routes from their ' +
        'content dates only; routes without one ship with no <lastmod>.'
    );
  }

  const routes = seoRoutes();
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...routes.map((route) =>
      urlEntry({
        loc: route.canonical,
        changefreq: route.changefreq,
        priority: route.priority,
        lastmod: lastmodFor(route, historyAvailable),
      })
    ),
    `</urlset>`,
    '',
  ].join('\n');

  writeFileSync(OUT, xml);
  const dated = routes.filter((r) => lastmodFor(r, historyAvailable) !== null).length;
  console.log(`Wrote sitemap with ${routes.length} URLs (${dated} dated) to ${OUT}`);
}

build();
