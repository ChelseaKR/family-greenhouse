#!/usr/bin/env node
/**
 * Emit `public/sitemap.xml` from the shared public-route list. Runs as a
 * `prebuild` step so the generated file is on disk by the time vite copies
 * /public/* into dist/.
 *
 * The route list itself lives in `public-routes.mjs`, which `prerender.mjs`
 * also reads — so the set of URLs we advertise and the set we actually render
 * static HTML for come from one place. `check-prerender-coverage.mjs` proves
 * they stayed equal after the build.
 *
 * Update cadence: blog posts and care guides go through their TS manifests, so
 * they sync automatically. Static pages (/blog, /changelog, /legal/privacy, …)
 * live in STATIC_ROUTES in public-routes.mjs — add to it when you ship a new
 * public route.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRONTEND_ROOT, SITE, publicRoutes } from './public-routes.mjs';

const OUT = join(FRONTEND_ROOT, 'public', 'sitemap.xml');

function urlEntry({ path, priority, changefreq, lastmod }) {
  const lines = [
    `  <url>`,
    `    <loc>${SITE}${path}</loc>`,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority.toFixed(1)}</priority>`,
  ];
  if (lastmod) lines.push(`    <lastmod>${lastmod}</lastmod>`);
  lines.push(`  </url>`);
  return lines.join('\n');
}

function build() {
  const all = publicRoutes();

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...all.map(urlEntry),
    `</urlset>`,
    '',
  ].join('\n');

  writeFileSync(OUT, xml);
  console.log(`Wrote sitemap with ${all.length} URLs to ${OUT}`);
}

build();
