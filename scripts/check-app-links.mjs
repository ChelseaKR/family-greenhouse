#!/usr/bin/env node
/**
 * Fail the build when the backend builds a link to a path the SPA does not route.
 *
 * ## The defect this exists to stop
 *
 * Every billing email — every transactional message about money, in `en` and
 * `es`, the one class of email that deliberately carries no unsubscribe link —
 * ended with `https://familygreenhouse.net/settings/notifications`. That is not
 * a route. `frontend/src/App.tsx` declares `/settings` and `/settings/billing`
 * and nothing between them, so React Router matched the catch-all and rendered
 * "Nothing growing here"; once issue #719's CloudFront change lands it becomes
 * a hard 404 instead. A customer who had just been charged, following the only
 * control the email offered, landed on a not-found page (issue #721).
 *
 * The working URL is `/settings?section=notifications`: the notifications tab
 * is reached by query parameter, not by path, and `SettingsPage.selectTab()`
 * has always built it that way.
 *
 * ## Why a gate and not just the one-line fix
 *
 * `backend/src/services/email/links.ts` already says in its header that it is
 * "the one place an email builds a URL", and already reasons about exactly
 * this hazard for `/tasks/:id`. The check had been done once, written down,
 * and then not applied to a link composed somewhere else — nothing re-derived
 * it. Worse, the billing footer's own unit test asserted the broken URL for
 * every notice kind in both locales, so the suite pinned the defect instead of
 * catching it.
 *
 * This gate re-derives the claim from the two sources of truth on every run:
 * the route table in `App.tsx`, and every app-origin URL the backend composes.
 * It fails on the NEXT link built without checking, which the one-line fix
 * does not.
 *
 * ## How a site is found, and how its origin is decided
 *
 * Regexes over the TypeScript, for the reason `frontend/scripts/
 * public-routes.mjs` gives for the same choice: importing .ts from a vanilla
 * Node script needs a loader, and the shapes here are stable.
 *
 * Three site shapes are collected, from `backend/src` and from the Cognito
 * email lambda (the one outbound-message composer that lives outside the
 * backend workspace):
 *
 *   1. `${ident}/some/path` inside a template literal.
 *   2. `helper('/some/path')` for the link helpers that own an origin —
 *      `appUrl`, `appLink`, `frontendUrl`.
 *   3. A literal `https://familygreenhouse.net/some/path`.
 *
 * An interpolation inside the path (`/join/${invite.code}`) is normalised to a
 * `:param` segment, because that is exactly what the router matches it with.
 *
 * Shape 1 is the one that needs judgement: `${base}/${key}` in `utils/s3.ts`
 * is an S3 asset, not a page. Rather than hand-listing files to skip — a list
 * that goes stale silently — the identifier is RESOLVED: scan backwards from
 * the site for its nearest binding and classify the right-hand side.
 * `FRONTEND_URL` / `appUrl` / `SITE_URL` bind the app origin; `ASSETS_BASE_URL`,
 * `apiBaseUrl`, `SPROUT_API_URL`, `POSTHOG_HOST` bind something else and the
 * site is dismissed BY NAME in the report.
 *
 * A site is considered at all when its identifier is origin-shaped (`base`,
 * `baseUrl`, `appUrl`, `SITE_URL`, `HOST` …) OR when its binding resolves to
 * the app origin whatever it is called — so an origin stored under an unusual
 * name is still examined, while `${plantId}/thumb.jpg` is not mistaken for one.
 * An origin-shaped identifier whose binding matches neither list is
 * UNRESOLVED: reported, and a hard failure, because a check that cannot tell
 * what origin a link hangs off must not report that link as fine.
 *
 * The run prints `paths resolving / paths examinable`. The denominator is the
 * honest part: a change that makes sites unreadable shows up as a shrinking
 * denominator rather than as a green check over nothing.
 *
 * Usage:  node scripts/check-app-links.mjs [--verbose]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_TSX = join(REPO_ROOT, 'frontend', 'src', 'App.tsx');

/** Everything that composes an outbound message or an API-returned link. */
export const SCAN_ROOTS = [
  join(REPO_ROOT, 'backend', 'src'),
  join(REPO_ROOT, 'infrastructure', 'modules', 'email', 'lambda'),
];

/** Origins that are not the SPA. A path under one of these is not a page link,
 *  and is dismissed by name in the report rather than skipped silently. */
const FOREIGN_ORIGINS = [
  ['ASSETS_BASE_URL', 'asset origin (plant photos on CloudFront), not a page'],
  ['apiBaseUrl', 'API origin — capability URLs must resolve with no session'],
  ['PUBLIC_API_URL', 'API origin — capability URLs must resolve with no session'],
  ['SPROUT_API_URL', 'a different product’s API'],
  ['POSTHOG_HOST', 'a third-party ingest host'],
  ['STRIPE', 'Stripe-hosted, not ours'],
];

/** Right-hand sides that bind the SPA origin. */
const APP_ORIGIN_RE =
  /FRONTEND_URL|SITE_URL|frontendBaseUrl|appBaseUrl|\bappUrl\b|firstAllowedOrigin/u;

/** Identifiers shaped like an origin: `base`, `baseUrl`, `appUrl`, `SITE_URL`,
 *  `HOST`. Deliberately does not match `PORT`, `token`, `plantId`. */
const ORIGIN_IDENT_RE = /(?:^|[a-z_])(?:base|origin|host|url|site)(?:[A-Z_]|$)/iu;

/** Link helpers that carry the app origin themselves, so a literal first
 *  argument is a path on our own site. */
const APP_LINK_HELPERS = ['appUrl', 'appLink', 'frontendUrl'];

const SITE_ORIGIN = 'https://familygreenhouse.net';

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

/**
 * Every `path=` the router declares, plus whether it declares a catch-all.
 *
 * The catch-all is collected but never used for matching: `*` matching
 * everything is precisely the behaviour that turned a dead link into a
 * not-found page instead of an error, so counting it as "resolves" would make
 * this gate unable to fail.
 *
 * THROWS on an empty read. The app has forty-odd routes; zero parsed means the
 * parser broke, not that the router emptied — and a gate that silently judges
 * nothing is worse than no gate.
 */
export function declaredRoutes(source = readFileSync(APP_TSX, 'utf8')) {
  const paths = [];
  let catchAll = false;
  const re = /\bpath="([^"]+)"/gu;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m[1] === '*') catchAll = true;
    else paths.push(m[1]);
  }
  if (paths.length === 0) {
    throw new Error(
      `No routes parsed from ${APP_TSX}. This gate compares backend-built links ` +
        'against the router’s own `path="..."` declarations; if that shape changed, ' +
        'fix this parser rather than shipping a check that passes on an empty table.'
    );
  }
  return { paths, catchAll };
}

/** True when `path` is matched by a declared route. `:param` matches exactly
 *  one non-empty segment; nothing matches the catch-all, on purpose. */
export function matchesRoute(path, routes) {
  const wanted = path.split(/[?#]/u)[0].replace(/\/+$/u, '') || '/';
  return routes.some((route) => {
    const pattern = route.replace(/\/+$/u, '') || '/';
    const a = pattern.split('/');
    const b = wanted.split('/');
    if (a.length !== b.length) return false;
    return a.every((seg, i) => (seg.startsWith(':') ? b[i].length > 0 : seg === b[i]));
  });
}

// ---------------------------------------------------------------------------
// The backend's links
// ---------------------------------------------------------------------------

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|mjs|js)$/u.test(entry) && !entry.endsWith('.d.ts')) yield full;
  }
}

/**
 * Read the path that follows `start` in `line`, stopping at the end of the
 * string or template literal. Each `${...}` inside the path becomes `:param`,
 * which is what the router matches it with; braces are counted so
 * `${encodeURIComponent(id)}` is consumed whole.
 *
 * Returns null when nothing that looks like a path follows.
 */
export function readPath(line, start) {
  if (line[start] !== '/') return null;
  let out = '';
  let i = start;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '`' || ch === "'" || ch === '"') break;
    if (ch === '$' && line[i + 1] === '{') {
      i += 1; // step onto the `{` so the counter opens on it
      let depth = 0;
      do {
        if (line[i] === '{') depth += 1;
        else if (line[i] === '}') depth -= 1;
        i += 1;
      } while (i < line.length && depth > 0);
      out += ':param';
      continue;
    }
    if (ch === ' ' || ch === ',' || ch === ')') break;
    out += ch;
    i += 1;
  }
  return out.length > 1 ? out : null;
}

/**
 * Classify the origin an identifier holds at a given line by scanning backwards
 * for its nearest binding. Returns `app`, `foreign` (with a reason), or
 * `unresolved`.
 */
export function resolveOrigin(lines, ident, lineIndex) {
  const escaped = ident.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const bindRe = new RegExp(`(?:const|let|var|function)\\s+${escaped}\\b`, 'u');
  for (let i = lineIndex; i >= 0; i -= 1) {
    if (!bindRe.test(lines[i])) continue;
    // Bindings here are at most a few lines of `a || b || c`; read enough of
    // the right-hand side to see which origin it came from.
    const rhs = lines.slice(i, i + 5).join('\n');
    const foreign = FOREIGN_ORIGINS.find(([token]) => rhs.includes(token));
    if (foreign) return { origin: 'foreign', why: foreign[1], binding: lines[i].trim() };
    if (APP_ORIGIN_RE.test(rhs)) return { origin: 'app', binding: lines[i].trim() };
    return { origin: 'unresolved', binding: lines[i].trim() };
  }
  return { origin: 'unresolved', binding: null };
}

/** Every app-origin path the backend composes, plus what was dismissed. */
export function collectSites(roots = SCAN_ROOTS) {
  const sites = [];
  const dismissed = [];
  const unresolved = [];
  const files = [];

  const helperRe = new RegExp(`\\b(${APP_LINK_HELPERS.join('|')})\\(\\s*['"\`]`, 'gu');

  for (const root of roots) {
    for (const file of walk(root)) {
      files.push(file);
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const where = relative(REPO_ROOT, file);

      lines.forEach((line, index) => {
        // Comments document paths (see links.ts's header on `/tasks/:id`);
        // they build nothing, so they are not sites.
        if (/^\s*(\*|\/\/)/u.test(line)) return;

        for (const m of line.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/gu)) {
          const ident = m[1];
          const after = m.index + m[0].length;
          if (line[after] !== '/') continue;
          const resolved = resolveOrigin(lines, ident, index);
          const originShaped = ORIGIN_IDENT_RE.test(ident);
          if (resolved.origin !== 'app' && !originShaped) continue;
          const path = readPath(line, after);
          const site = { where, line: index + 1, ident, path, text: line.trim() };
          if (resolved.origin === 'foreign') dismissed.push({ ...site, why: resolved.why });
          else if (resolved.origin === 'unresolved') {
            unresolved.push({ ...site, binding: resolved.binding });
          } else if (path) sites.push(site);
        }

        for (const m of line.matchAll(helperRe)) {
          const path = readPath(line, m.index + m[0].length);
          if (path) sites.push({ where, line: index + 1, ident: m[1], path, text: line.trim() });
        }

        let from = 0;
        for (;;) {
          const at = line.indexOf(SITE_ORIGIN, from);
          if (at === -1) break;
          const path = readPath(line, at + SITE_ORIGIN.length);
          if (path)
            sites.push({ where, line: index + 1, ident: 'literal', path, text: line.trim() });
          from = at + SITE_ORIGIN.length;
        }
      });
    }
  }
  return { sites, dismissed, unresolved, files };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function main() {
  const verbose = process.argv.includes('--verbose');
  const { paths: routes, catchAll } = declaredRoutes();
  const { sites, dismissed, unresolved, files } = collectSites();

  const dead = sites.filter((site) => !matchesRoute(site.path, routes));
  const examinable = sites.length;
  const resolving = examinable - dead.length;

  console.log(
    `app-links: ${routes.length} routes declared in frontend/src/App.tsx` +
      `${catchAll ? ' (plus a catch-all, never counted as a match)' : ''}`
  );
  console.log(`app-links: ${files.length} source files swept for outbound links`);
  console.log(
    `app-links: ${resolving}/${examinable} backend-built paths resolve to a declared route`
  );
  console.log(
    `app-links: ${dismissed.length} dismissed as another origin, ${unresolved.length} unresolved`
  );

  if (verbose) {
    for (const site of sites) {
      const ok = matchesRoute(site.path, routes) ? 'ok  ' : 'DEAD';
      console.log(`  ${ok} ${site.path.padEnd(30)} ${site.where}:${site.line}`);
    }
    for (const site of dismissed) {
      console.log(
        `  skip ${String(site.path).padEnd(30)} ${site.where}:${site.line} — ${site.why}`
      );
    }
  }

  for (const site of unresolved) {
    console.error(
      `app-links: UNRESOLVED origin for \`${site.ident}\` at ${site.where}:${site.line} — ` +
        `${site.binding ? `bound by \`${site.binding}\`` : 'no binding found in this file'}. ` +
        'Bind it from FRONTEND_URL (the app) or from a named foreign origin, so this gate can ' +
        'tell a page link from an asset URL.'
    );
  }

  if (dead.length > 0) {
    console.error('');
    console.error('app-links: these backend-built URLs are not routes the SPA declares:');
    for (const site of dead) {
      console.error(`  ${site.path}`);
      console.error(`      ${site.where}:${site.line}   ${site.text}`);
    }
    console.error('');
    console.error(
      'A link matching no route falls through to the catch-all and renders "Nothing growing ' +
        'here" — and, once the CloudFront change in #719 lands, a hard 404. Either declare the ' +
        'route in frontend/src/App.tsx or point the link at one that exists (the settings tabs ' +
        'are query parameters: /settings?section=notifications).'
    );
  }

  if (dead.length > 0 || unresolved.length > 0) {
    console.error('app-links: gate FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('app-links: ok');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
