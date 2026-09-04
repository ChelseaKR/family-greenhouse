#!/usr/bin/env node
/**
 * Re-derive figures that prose states from the artifact that owns them.
 *
 * A number typed into a document is a committed artifact standing in for a
 * computation. If nothing re-runs the computation, the number is true only on
 * the day it was typed, and a reader has no way to tell which day that was.
 * Both figures below were measurably wrong when this gate was written:
 *
 *   - `docs/quality-audit.md` said the OpenAPI spec documents "66 handler
 *     routes", twice, and called that "CI-enforced against drift". The
 *     enforcement is real and green — `scripts/check-api-spec.mjs` holds the
 *     spec and the handlers in step — but it never reported its number back to
 *     the document that quotes it. The handlers now expose 105 routes. The
 *     audit was 39 routes stale while truthfully describing a passing gate.
 *
 *   - `README.md` said "root/workspace versions are aligned at 0.23.0". They
 *     are aligned, at 0.23.2. `scripts/validate-store-release.mjs` enforces the
 *     three-way alignment but never reads the README, and it is in neither
 *     `verify` nor CI.
 *
 * Every check here fails in BOTH directions, which is the property that makes
 * it worth having: a wrong figure fails, and so does a document that stops
 * making the claim at all. A check satisfied by deleting the sentence is a
 * check that quietly stops checking. This mirrors `scripts/check-docs-testing.mjs`,
 * which does the same for `docs/testing.md`, and is wired into the same
 * `npm run verify`.
 *
 * The handler-route count is now DERIVED, not documented. Pinning the digit in
 * prose fixed the staleness and bought a conflict: the count lives in two
 * sentences of `docs/quality-audit.md`, so every PR that adds a route rewrote
 * both, and on 2026-09-03 the file was in the conflict set of most of fifteen
 * PRs open in parallel — four rebase cycles were spent re-running this gate and
 * hand-reconciling a number it can compute. `--print` reports the live count on
 * demand, and the checks below keep what a reader actually relies on: that the
 * spec covers every route and is gated on drift, and that the audit says where
 * to get the number. A re-introduced hard-coded live count is REFUSED, exactly
 * as `check-docs-testing.mjs` refuses a `Files` column or an "across N files"
 * total (PR #410) — same defect, same remedy, so the conflict surface cannot
 * come back. The dated correction note at the top of the audit is deliberately
 * exempt: it is a frozen record of a past error, not a live claim.
 *
 * This script reads. It never rewrites a document to match: a gate that
 * repairs its own subject makes drift invisible instead of loud.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findHandlerRoutes } from './check-api-spec.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function version(relative) {
  return JSON.parse(read(relative)).version;
}

/**
 * Assert that `pattern` matches `text` exactly `expectedMatches` times and that
 * every capture of group 1 equals `expected`.
 *
 * `expectedMatches` is what closes the deletion loophole: a check that accepted
 * "zero or more matches, all correct" would go green the moment someone dropped
 * the sentence it was meant to police.
 */
function statesFigure({ file, label, pattern, expected, expectedMatches }) {
  const text = read(file);
  const found = [...text.matchAll(pattern)].map((m) => m[1]);
  if (found.length !== expectedMatches) {
    problems.push(
      `${file}: expected ${expectedMatches} statement(s) of ${label}, found ${found.length}. ` +
        `The sentence that states it was reworded or removed; restore it (or update this gate ` +
        `deliberately, in the same change).`
    );
    return;
  }
  for (const actual of found) {
    if (actual !== String(expected)) {
      problems.push(
        `${file}: states ${label} as ${actual}; re-derived from the repository it is ${expected}.`
      );
    }
  }
}

const AUDIT = 'docs/quality-audit.md';

// --- The derived figures ----------------------------------------------------
// The route count comes from the same scan `scripts/check-api-spec.mjs` uses,
// imported rather than re-implemented, so the audit's claim and the gate's
// number cannot drift apart from each other while both look right in isolation.
const routeCount = findHandlerRoutes().size;

const versions = {
  'package.json': version('package.json'),
  'frontend/package.json': version('frontend/package.json'),
  'backend/package.json': version('backend/package.json'),
};
const distinct = [...new Set(Object.values(versions))];

// `--print` is how a reader gets the route count now that no document carries
// it. It reports; it checks nothing, so it stays useful on a branch whose docs
// are mid-edit.
if (process.argv.includes('--print')) {
  const rows = [
    ['handler routes', String(routeCount)],
    [
      'root/workspace version',
      distinct.length === 1
        ? distinct[0]
        : `not aligned (${Object.entries(versions)
            .map(([f, v]) => `${f}=${v}`)
            .join(', ')})`,
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) console.log(`${label.padEnd(width)}  ${value}`);
  process.exit(0);
}

// --- docs/quality-audit.md: the handler-route count -------------------------
// The audit no longer states the count. Block quotes are excluded from the scan
// below: the dated correction note at the top of the file records a figure that
// WAS wrong on a stated date, which is history, not a live claim.
const auditBody = read(AUDIT)
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('>'))
  .join('\n');

// The retired figure. A written-down count is a hand-maintained number that
// every route-adding PR has to rewrite in both sentences that carry it; see the
// header comment for what that cost. Same refusal as the `Files` column in
// check-docs-testing.mjs.
for (const match of auditBody.matchAll(/\d[\d,]*\s+(?:handler[- ])?routes\b/g)) {
  problems.push(
    `${AUDIT}: says "${match[0]}" — a hand-maintained route count. The count is derived ` +
      `(\`node scripts/check-doc-figures.mjs --print\`), not documented: write "every handler ` +
      `route" and let \`scripts/check-api-spec.mjs\` be the thing that makes that true.`
  );
}

// Both directions, without a digit to compare: the audit must still name the
// gate that backs "every handler route", and must still tell a reader where to
// get the number it stopped printing. Dropping either is the deletion loophole.
const AUDIT_MUST_MENTION = [
  ['scripts/check-api-spec.mjs', 'the drift gate that makes "every handler route" true'],
  ['scripts/check-doc-figures.mjs --print', 'where a reader gets the live route count'],
];
for (const [needle, why] of AUDIT_MUST_MENTION) {
  if (!auditBody.includes(needle)) {
    problems.push(
      `${AUDIT}: no longer mentions \`${needle}\` — ${why}. Restore it (or update this gate ` +
        `deliberately, in the same change).`
    );
  }
}

// --- README.md: the aligned workspace version -------------------------------
if (distinct.length !== 1) {
  // The README's claim is "aligned at X". If they are not aligned, the claim is
  // false whatever number it names, so say that rather than comparing to one.
  problems.push(
    `root/workspace versions are not aligned: ` +
      Object.entries(versions)
        .map(([f, v]) => `${f}=${v}`)
        .join(', ') +
      `. README.md's Release & Versioning row claims they are.`
  );
} else {
  statesFigure({
    file: 'README.md',
    label: 'the aligned root/workspace version',
    pattern: /root\/workspace versions are aligned at ([0-9]+\.[0-9]+\.[0-9]+)/g,
    expected: distinct[0],
    expectedMatches: 1,
  });
}

if (problems.length > 0) {
  console.error('\n❌ Stated figures no longer match the repository:\n');
  for (const p of problems) console.error(`   ${p}`);
  console.error('\nFix the document, not this gate.');
  process.exit(1);
}

console.log(
  `Doc figures OK — quality-audit.md states no hand-maintained route count ` +
    `(${routeCount} handler routes on disk, via --print) and README's aligned version ` +
    `(${distinct[0]}) re-derived from the repository.`
);
