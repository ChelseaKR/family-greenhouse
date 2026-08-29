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
 * stating the figure at all. A check satisfied by deleting the sentence is a
 * check that quietly stops checking. This mirrors `scripts/check-docs-testing.mjs`,
 * which does the same for `docs/testing.md`, and is wired into the same
 * `npm run verify`.
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
 * `expectedMatches` is what closes the deletion loophole: the audit states the
 * route count in two separate sentences, and a check that accepted "zero or
 * more matches, all correct" would go green the moment someone dropped one.
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

// --- docs/quality-audit.md: the handler-route count -------------------------
// Derived from the same scan `scripts/check-api-spec.mjs` uses, imported rather
// than re-implemented, so the audit's number and the gate's number cannot drift
// apart from each other while both look right in isolation.
const routeCount = findHandlerRoutes().size;
statesFigure({
  file: 'docs/quality-audit.md',
  label: 'the handler-route count',
  pattern: /(\d+)\s+handler routes/g,
  expected: routeCount,
  expectedMatches: 2,
});

// --- README.md: the aligned workspace version -------------------------------
const versions = {
  'package.json': version('package.json'),
  'frontend/package.json': version('frontend/package.json'),
  'backend/package.json': version('backend/package.json'),
};
const distinct = [...new Set(Object.values(versions))];
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
  `Doc figures OK — handler-route count (${routeCount}) and aligned version ` +
    `(${distinct[0]}) re-derived from the repository.`
);
