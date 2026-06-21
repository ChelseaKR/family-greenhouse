#!/usr/bin/env node
/**
 * Emit `public/sitemap.xml` from the static-route list + the blog post
 * manifest. Runs as a `prebuild` step so the generated file is on disk
 * by the time vite copies /public/* into dist/.
 *
 * Why a regex over the TS manifest instead of a real import: importing a
 * .tsx module from a vanilla Node script needs a loader (ts-node, tsx,
 * node --experimental-strip-types). The slugs in posts/index.ts are
 * single-quoted string literals on a stable line shape; matching them
 * with a regex is simpler and avoids the loader dance.
 *
 * Update cadence: blog posts go through the manifest, so they sync
 * automatically. Static pages (/blog, /changelog, /legal/privacy, etc.)
 * live in the STATIC_ROUTES list below — add to it when you ship a new
 * public route.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS = join(ROOT, 'src', 'features', 'blog', 'posts', 'index.ts');
const CARE = join(ROOT, 'src', 'features', 'care', 'careGuides.ts');
const OUT = join(ROOT, 'public', 'sitemap.xml');

// Canonical production origin. MUST match src/config/site.ts (SITE_URL) — this
// is a vanilla Node script so it can't import the TS const. The prior default
// (app.familygreenhouse.com) doesn't resolve, so every generated <loc> pointed
// search engines at a dead domain.
const SITE = process.env.SITE_URL || 'https://familygreenhouse.net';

const STATIC_ROUTES = [
  { path: '/', priority: 1.0, changefreq: 'weekly' },
  { path: '/pricing', priority: 0.9, changefreq: 'monthly' },
  { path: '/blog', priority: 0.8, changefreq: 'weekly' },
  { path: '/care', priority: 0.8, changefreq: 'weekly' },
  { path: '/pet-safe', priority: 0.8, changefreq: 'monthly' },
  { path: '/changelog', priority: 0.5, changefreq: 'weekly' },
  { path: '/status', priority: 0.3, changefreq: 'daily' },
  { path: '/legal/privacy', priority: 0.3, changefreq: 'yearly' },
  { path: '/legal/terms', priority: 0.3, changefreq: 'yearly' },
];

function readBlogSlugs() {
  const src = readFileSync(POSTS, 'utf8');
  // Match `slug: 'something-here',` — the canonical form in the manifest.
  const re = /slug:\s*'([^']+)'/g;
  const slugs = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    slugs.push(m[1]);
  }
  return slugs;
}

function readBlogDates() {
  const src = readFileSync(POSTS, 'utf8');
  const re = /slug:\s*'([^']+)'[\s\S]*?date:\s*'([^']+)'/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src)) !== null) {
    out.set(m[1], m[2]);
  }
  return out;
}

// Care guides share the manifest-regex approach: `slug: 'x'` + `reviewed: 'date'`.
function readCareGuides() {
  const src = readFileSync(CARE, 'utf8');
  const re = /slug:\s*'([^']+)'[\s\S]*?reviewed:\s*'([^']+)'/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src)) !== null) {
    out.set(m[1], m[2]);
  }
  return out;
}

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
  const slugs = readBlogSlugs();
  const dates = readBlogDates();
  const today = new Date().toISOString().slice(0, 10);
  const blogEntries = slugs.map((slug) => ({
    path: `/blog/${slug}`,
    priority: 0.7,
    changefreq: 'monthly',
    lastmod: dates.get(slug) ?? today,
  }));

  const care = readCareGuides();
  const careEntries = [...care.entries()].map(([slug, reviewed]) => ({
    path: `/care/${slug}`,
    priority: 0.7,
    changefreq: 'monthly',
    lastmod: reviewed ?? today,
  }));

  const all = [...STATIC_ROUTES, ...blogEntries, ...careEntries];

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
