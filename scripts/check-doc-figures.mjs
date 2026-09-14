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

import { existsSync, readFileSync } from 'node:fs';
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

// --- docs/billing.md: the plan caps -----------------------------------------
// Added after the table was found stale on FIVE of its six cap figures while
// real cards were being charged: Seedling read 10 plants / 6 members against an
// actual 20 / 3, Garden 500 / 6 against 200 / unlimited, Greenhouse 50 members
// against unlimited. #618 fixed the same defect in the help pages and this file
// was missed, which is the argument for deriving it rather than fixing it once
// more by hand.
//
// The prose under the table made it worse than a stale number: it instructed a
// reader who saw a smaller figure in `plans.ts` not to "fix" `plans.ts` but to
// trust this table — pointing maintainers away from the source of truth. A
// document that can send someone to correct the code from the doc is one that
// has to be gated in the direction the repository actually reads.
const BILLING = 'docs/billing.md';
const plansSource = read('backend/src/models/plans.ts');

/** Read one `limits` field off a tier in `plans.ts`. `UNLIMITED` is `null`. */
function planLimit(tier, field) {
  const block = plansSource.match(
    new RegExp(`id: '${tier}'[\\s\\S]*?limits:\\s*\\{([\\s\\S]*?)\\}`)
  );
  if (block === null) {
    problems.push(`backend/src/models/plans.ts: no limits block for tier "${tier}".`);
    return null;
  }
  const value = block[1].match(new RegExp(`\\b${field}:\\s*([A-Za-z0-9_]+)`));
  if (value === null) {
    problems.push(`backend/src/models/plans.ts: tier "${tier}" has no \`${field}\` limit.`);
    return null;
  }
  return value[1] === 'UNLIMITED' ? 'Unlimited' : value[1];
}

for (const tier of ['seedling', 'garden', 'greenhouse']) {
  const plants = planLimit(tier, 'plants');
  const members = planLimit(tier, 'members');
  if (plants === null || members === null) continue;

  // One row per tier, matched as a whole so a reordered or deleted row fails
  // rather than silently matching nothing.
  //
  // Anchored to the start of a line, and every skipped cell is `[^|\n]*` rather
  // than `[^|]*`: "Seedling" is also the value of the last cell in the
  // entitlement table above, and a cell pattern that can cross a newline walks
  // out of that row into the next one and matches twice. The gate caught that
  // while it was being written, which is the behaviour these patterns want.
  const name = tier[0].toUpperCase() + tier.slice(1);
  const row = `^\\|\\s*${name}\\s*\\|`;
  const cell = '[^|\\n]*\\|';
  statesFigure({
    file: BILLING,
    label: `the ${name} plants cap`,
    pattern: new RegExp(`${row}${cell}\\s*([A-Za-z0-9]+)\\s*\\|`, 'gm'),
    expected: plants,
    expectedMatches: 1,
  });
  statesFigure({
    file: BILLING,
    label: `the ${name} members cap`,
    pattern: new RegExp(`${row}${cell}${cell}\\s*([A-Za-z0-9]+)\\s*\\|`, 'gm'),
    expected: members,
    expectedMatches: 1,
  });
}

// --- docs/security.md: the shipped Content-Security-Policy ------------------
// The audit published a directive list that had gone stale in the direction
// that matters: it said `script-src 'self'` "(no `unsafe-eval` or
// `unsafe-inline`)" while the shipped policy also admits
// `https://www.googletagmanager.com`, and `connect-src` admits Tag Manager and
// two Google Analytics hosts. A security document that under-states what its
// own policy permits is worse than one that says nothing, because a reviewer
// stops at the document.
//
// The repair is the same one this file applies everywhere else: the document
// quotes the policy and the gate re-derives it, so the two cannot drift. A
// re-worded summary is fine — the fenced block is what is compared.
const SECURITY = 'docs/security.md';
const cspMeta = read('frontend/index.html').match(
  /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/
);
if (cspMeta === null) {
  problems.push(
    `frontend/index.html: no <meta http-equiv="Content-Security-Policy"> — ${SECURITY} says one ` +
      `ships. Either restore it or rewrite that section deliberately, in the same change.`
  );
} else {
  const shipped = cspMeta[1].replace(/\s+/g, ' ').trim();
  const quoted = [...read(SECURITY).matchAll(/```\n([^`]*default-src[^`]*?)\n```/g)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim()
  );
  if (quoted.length !== 1) {
    problems.push(
      `${SECURITY}: expected exactly 1 fenced block quoting the shipped CSP, found ${quoted.length}. ` +
        `The block that carries the policy was removed or duplicated; restore it (or update this ` +
        `gate deliberately, in the same change).`
    );
  } else if (quoted[0] !== shipped) {
    problems.push(
      `${SECURITY}: quotes a CSP that frontend/index.html no longer ships.\n` +
        `      document: ${quoted[0]}\n` +
        `      shipped:  ${shipped}`
    );
  }
}

// --- docs/analytics.md: the event vocabulary --------------------------------
// The privacy policy tells a reader "The full event list is in our repo at
// `docs/analytics.md`" (legal.privacy.collect.telemetryEvents). That sentence
// is a promise about a DOCUMENT, so it is only true while the document is
// complete — and it was not: `upgrade_requested` shipped in both the browser
// union and the server's accept-list and was documented nowhere, so the
// published list was one event short of what the product captures. A reader
// checking what we collect would have come away with a wrong answer from the
// page we sent them to.
//
// Three sets, re-derived rather than restated, and every pair compared in both
// directions:
//
//   - `EventName` in frontend/src/services/analytics.ts — what the browser may
//     emit.
//   - `productEventNames` in backend/src/models/telemetry.ts — what the API
//     will accept. An event only in the first is dropped on arrival with
//     nothing to show for it; one only in the second is dead vocabulary.
//   - the `| \`event\` |` rows of docs/analytics.md — what we published.
//
// `ServerEventName` (backend/src/utils/serverAnalytics.ts) is derived too, so
// the three Stripe-confirmed events documented in the second table are not a
// hard-coded exemption that would hide a fourth.
const ANALYTICS = 'docs/analytics.md';

/**
 * Quoted string literals inside one TypeScript declaration.
 *
 * Comments are stripped first. Every one of these declarations is heavily
 * commented, and the comments quote OTHER literals — `'lifetime'`,
 * `'trialing'` — which a naive scan reads as event names and then reports as
 * undocumented. That is a gate failing for a reason that has nothing to do
 * with its subject, which is how a gate gets switched off.
 */
function namesIn(file, startNeedle, endNeedle) {
  const text = read(file);
  const start = text.indexOf(startNeedle);
  if (start === -1) {
    problems.push(
      `${file}: no \`${startNeedle}\` declaration — this gate reads its names from it.`
    );
    return [];
  }
  const end = text.indexOf(endNeedle, start);
  const block = text
    .slice(start, end === -1 ? undefined : end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...block.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]);
}

const browserEvents = namesIn(
  'frontend/src/services/analytics.ts',
  'export type EventName =',
  'export interface EventProps'
);
const acceptedEvents = namesIn(
  'backend/src/models/telemetry.ts',
  'export const productEventNames = [',
  '] as const;'
);
const serverEvents = namesIn(
  'backend/src/utils/serverAnalytics.ts',
  'export type ServerEventName =',
  'export interface ServerEventProps'
);

for (const [from, to, fromLabel, toLabel, why] of [
  [
    browserEvents,
    acceptedEvents,
    'the browser EventName union',
    "the API's productEventNames",
    'the API rejects it, so the event is captured nowhere',
  ],
  [
    acceptedEvents,
    browserEvents,
    "the API's productEventNames",
    'the browser EventName union',
    'nothing can send it, so it is dead vocabulary',
  ],
]) {
  for (const name of from) {
    if (!to.includes(name)) {
      problems.push(`${ANALYTICS}: \`${name}\` is in ${fromLabel} but not ${toLabel} — ${why}.`);
    }
  }
}

const documentedEvents = [...read(ANALYTICS).matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm)].map(
  (m) => m[1]
);
const capturable = [...new Set([...browserEvents, ...acceptedEvents, ...serverEvents])];

for (const name of capturable) {
  if (!documentedEvents.includes(name)) {
    problems.push(
      `${ANALYTICS}: does not document \`${name}\`, which the code can capture. The privacy ` +
        `policy sends readers here for the FULL event list, so an undocumented event makes that ` +
        `sentence false. Add a table row for it.`
    );
  }
}
for (const name of documentedEvents) {
  if (!capturable.includes(name)) {
    problems.push(
      `${ANALYTICS}: documents \`${name}\`, which no longer exists in the browser union, the ` +
        `API accept-list, or the server events. Remove the row (or restore the event).`
    );
  }
}

// --- docs/analytics.md: every funnel stage still has a live emitter ---------
// The funnel table under `## The funnel` is the contract the PostHog dashboards
// are built on: sign-up → confirm → activate → hit a limit → open billing →
// checkout started → checkout completed. Each row names the event and the file
// that emits it. A stage whose call site is refactored away does not fail a
// type check (the union member still exists), does not fail the vocabulary
// checks above (the name is still declared everywhere), and does not fail at
// runtime (nothing calls it). It shows up as a permanent zero on a funnel
// step, which reads as "nobody reaches this stage" — the most expensive
// misreading a conversion dashboard can produce.
//
// So each named file must still contain the event literal in CODE. Comments
// are stripped first: four conformance checks once passed on tool names that
// only appeared in comments, and this gate is not going to be the fifth.
const FUNNEL_HEADING = '## The funnel';
const FUNNEL_STAGES_EXPECTED = 7;
const analyticsDoc = read(ANALYTICS);
const funnelStart = analyticsDoc.indexOf(FUNNEL_HEADING);
if (funnelStart === -1) {
  problems.push(
    `${ANALYTICS}: no \`${FUNNEL_HEADING}\` section — the funnel table is the contract this ` +
      `gate holds the call sites to.`
  );
} else {
  const afterHeading = analyticsDoc.slice(funnelStart + FUNNEL_HEADING.length);
  const nextHeading = afterHeading.search(/^## /m);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  const funnelRows = [
    ...section.matchAll(/^\|\s*\d+\s*\|[^|]*\|\s*`([a-z][a-z0-9_]*)`\s*\|\s*`([^`]+)`\s*\|/gm),
  ].map(([, event, file]) => ({ event, file }));

  if (funnelRows.length !== FUNNEL_STAGES_EXPECTED) {
    problems.push(
      `${ANALYTICS}: the funnel table has ${funnelRows.length} stage rows, expected ` +
        `${FUNNEL_STAGES_EXPECTED} (| n | stage | \`event\` | \`path/to/emitter\` | ...). A stage ` +
        `dropped from the table is a stage nobody is watching; add or remove one deliberately, ` +
        `in the same change as FUNNEL_STAGES_EXPECTED.`
    );
  }
  for (const { event, file } of funnelRows) {
    if (!capturable.includes(event)) {
      problems.push(
        `${ANALYTICS}: funnel stage \`${event}\` is not an event the code can capture.`
      );
      continue;
    }
    if (!existsSync(join(ROOT, file))) {
      problems.push(`${ANALYTICS}: funnel stage \`${event}\` names ${file}, which does not exist.`);
      continue;
    }
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    if (!code.includes(`'${event}'`)) {
      problems.push(
        `${ANALYTICS}: funnel stage \`${event}\` is documented as emitted by ${file}, but that ` +
          `file no longer emits it (the literal '${event}' is not in its code; comments do not ` +
          `count). The funnel dashboard would show this stage as a permanent zero. Restore the ` +
          `call, or move the row to the file that now emits it.`
      );
    }
  }
}

if (problems.length > 0) {
  console.error('\n❌ Stated figures no longer match the repository:\n');
  for (const p of problems) console.error(`   ${p}`);
  console.error('\nFix the document, not this gate.');
  process.exit(1);
}

console.log(
  `Doc figures OK — quality-audit.md states no hand-maintained route count ` +
    `(${routeCount} handler routes on disk, via --print), README's aligned version ` +
    `(${distinct[0]}), billing.md's six plan caps, analytics.md's ${capturable.length} ` +
    `capturable events and its ${FUNNEL_STAGES_EXPECTED}-stage funnel's call sites all ` +
    `re-derived from the repository.`
);
